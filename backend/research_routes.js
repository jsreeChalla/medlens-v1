/**
 * research_routes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop-in Express router for the Research RAG feature.
 *
 * SETUP — add these lines to server.js right after `app.use(express.json())`:
 *
 *   const researchRouter = require("./research_routes");
 *   app.use("/api/research", researchRouter);
 *
 * DEPENDENCIES (add to package.json):
 *   npm install multer pdf-parse uuid
 */

const express        = require("express");
const multer         = require("multer");
const { PDFParse }   = require("pdf-parse");
const { v4: uuidv4 } = require("uuid");
const Groq           = require("groq-sdk");
const rag            = require("./research_rag");

const router = express.Router();
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL  = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

async function pdfParse(buffer) {
  const parser = new PDFParse({ data: buffer });
  const data   = await parser.getText();
  await parser.destroy();
  return { text: data.text, numpages: data.numpages };
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are accepted."));
  },
});

// ── Agentic RAG: Tool Definitions ─────────────────────────────────────────────
// OPTIMISATION: top_k default lowered to 3 (was 5), max capped at 6 (was 10).
// Fewer passages per call → fewer tokens consumed per tool result.
const RESEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_papers",
      description:
        "Search the uploaded research papers using BM25 full-text retrieval. " +
        "Returns the most relevant passages for a query. " +
        "Call this whenever the user asks a question that might be answered by the papers. " +
        "You may call it multiple times with different queries to gather evidence from different angles.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query. Be specific — use key terms from the topic.",
          },
          top_k: {
            type: "integer",
            description: "Number of passages to retrieve (default 3, max 6). Only increase if first search was insufficient.",
            minimum: 1,
            maximum: 6,   // was 10
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_papers",
      description:
        "List all uploaded research papers with their titles and page counts. " +
        "Call this when the user asks what papers are loaded, or to orient yourself before searching.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_paper_info",
      description:
        "Get metadata about a specific paper by its ID (title, page count, chunk count, upload date). " +
        "Useful when the user refers to a paper by name and you want to confirm you have it.",
      parameters: {
        type: "object",
        properties: {
          paper_id: { type: "string", description: "The paper ID from list_papers." },
        },
        required: ["paper_id"],
      },
    },
  },
];

// ── Tool Executor ─────────────────────────────────────────────────────────────
// OPTIMISATION: seenChunkKeys is threaded through every call so duplicate
// chunks are never serialised into the LLM context a second time.
async function executeTool(name, args, seenChunkKeys) {
  console.log(`[RESEARCH TOOL] ${name}(${JSON.stringify(args)})`);

  switch (name) {
    case "search_papers": {
      const topK   = Math.min(args.top_k || 3, 6);
      const results = rag.searchChunks(
        args.query,
        topK,
        120,           // maxPassageWords — hard cap, ~90 tokens per passage
        seenChunkKeys  // skip chunks already in context
      );

      if (results.length === 0) {
        return { results: [], note: "No relevant passages found. Try rephrasing your query." };
      }

      // Register returned chunks so they are not sent again this turn
      for (const r of results) seenChunkKeys.add(r.chunkKey);

      return {
        query: args.query,
        results: results.map(r => ({
          paperTitle: r.paperTitle,
          paperId:    r.paperId,
          relevance:  parseFloat(r.score.toFixed(3)),
          // OPTIMISATION: Only `text` (trimmed passage) is sent — not the raw
          // full-length chunk.  `excerpt` is only used for SSE display.
          passage:    r.text,
          excerpt:    r.excerpt,
        })),
      };
    }

    case "list_papers": {
      const papers = rag.listPapers();
      // OPTIMISATION: Strip charCount / chunkCount from the LLM-facing payload;
      // those fields are internal bookkeeping, not useful for reasoning.
      return papers.length > 0
        ? {
            count: papers.length,
            papers: papers.map(p => ({ id: p.id, title: p.title, pageCount: p.pageCount })),
          }
        : { count: 0, note: "No papers uploaded yet." };
    }

    case "get_paper_info": {
      const paper = rag.getPaper(args.paper_id);
      return paper
        ? { id: paper.id, title: paper.title, pageCount: paper.pageCount, uploadedAt: paper.uploadedAt }
        : { error: `Paper ID "${args.paper_id}" not found.` };
    }

    default:
      return { error: `Unknown tool: "${name}"` };
  }
}

// ── Agentic Loop ──────────────────────────────────────────────────────────────

// OPTIMISATION: System prompt trimmed — removed verbose restatements; the LLM
// only needs the core contract, not a tutorial.
const SYSTEM_PROMPT = `You are a Research Assistant AI with access to uploaded research papers via tools.

Rules:
- Always call search_papers before answering a substantive question
- Use 1-2 targeted searches; only add a third if coverage is genuinely missing
- Cite specific passages with the paper title
- If something is NOT covered in the papers, say so — do not fabricate
- End answers with a "Sources:" section listing papers you drew from
- For questions unrelated to papers, answer briefly from general knowledge and note it`;

async function runAgenticLoop(messages, onEvent, maxIter = 5) {
  let history = [...messages];

  // OPTIMISATION: One Set per conversation turn tracks every chunk key already
  // included in a tool result so the same passage is never sent twice.
  const seenChunkKeys = new Set();

  for (let i = 0; i < maxIter; i++) {
    const response = await groq.chat.completions.create({
      model:       MODEL,
      messages:    history,
      tools:       RESEARCH_TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
      // OPTIMISATION: Intermediate reasoning steps don't need 2000 tokens.
      // 800 is ample for a tool-call decision + brief reasoning.
      // The final answer step below uses 1200.
      max_tokens:  800,
    });

    const choice = response.choices[0];
    const msg    = choice.message;
    history.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // This IS the final answer — return it directly
      return msg.content || "";
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}

      onEvent({ type: "tool_call", tool: tc.function.name, args });

      const result = await executeTool(tc.function.name, args, seenChunkKeys);

      onEvent({ type: "tool_result", tool: tc.function.name, ok: !result.error, result });

      history.push({
        role:         "tool",
        tool_call_id: tc.id,
        content:      JSON.stringify(result),
      });
    }
  }

  // Force final answer after max iterations
  console.warn("[RESEARCH AGENT] Max iterations — forcing final answer");
  const fallback = await groq.chat.completions.create({
    model:      MODEL,
    messages: [
      ...history,
      { role: "user", content: "Please now provide your final synthesised answer based on the retrieved passages." },
    ],
    temperature: 0.2,
    max_tokens:  1200,
  });
  return fallback.choices[0]?.message?.content || "Unable to generate a response.";
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/papers", (req, res) => {
  res.json({ papers: rag.listPapers() });
});

router.post("/upload", upload.array("files", 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No PDF files received." });
  }

  const results = [];
  const errors  = [];

  for (const file of req.files) {
    try {
      const parsed = await pdfParse(file.buffer);
      const id     = uuidv4();
      const title  = file.originalname.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
      const paper  = rag.addPaper(id, title, file.originalname, parsed.text, parsed.numpages);
      results.push(paper);
      console.log(`[UPLOAD] "${title}" — ${parsed.numpages} pages, ${parsed.text.length} chars`);
    } catch (err) {
      console.error(`[UPLOAD] Error parsing ${file.originalname}: ${err.message}`);
      errors.push({ filename: file.originalname, error: err.message });
    }
  }

  res.json({ uploaded: results, errors, totalPapers: rag.listPapers().length });
});

router.delete("/papers/:id", (req, res) => {
  const removed = rag.removePaper(req.params.id);
  if (!removed) return res.status(404).json({ error: "Paper not found." });
  res.json({ ok: true, totalPapers: rag.listPapers().length });
});

router.delete("/papers", (req, res) => {
  rag.clearAll();
  res.json({ ok: true, totalPapers: 0 });
});

/**
 * POST /api/research/chat
 * Body: { message: string, history: [{role, content}]? }
 *
 * SSE events:
 *   { type: "tool_call",   tool, args }
 *   { type: "tool_result", tool, ok, result }
 *   { type: "token",       token }
 *   { type: "done" }
 *   { type: "error",       error }
 */
router.post("/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  const papers = rag.listPapers();
  if (papers.length === 0) {
    return res.status(400).json({ error: "No papers loaded. Please upload PDFs first." });
  }

  console.log(`[RESEARCH CHAT] "${message.slice(0, 80)}" | papers: ${papers.length}`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    // OPTIMISATION: Paper list in the system prompt carries only title + id,
    // not charCount, chunkCount, uploadedAt — saves ~20 tokens per paper.
    const paperList = papers.map(p => `• ${p.title} (${p.pageCount} pages, ID: ${p.id})`).join("\n");

    const messages = [
      {
        role:    "system",
        content: SYSTEM_PROMPT + `\n\nLoaded papers:\n${paperList}`,
      },
      // OPTIMISATION: Trim history to last 6 turns to prevent runaway context.
      // Each turn can be many tokens if prior answers included long passages.
      ...history.slice(-6).map(({ role, content }) => ({ role, content })),
      { role: "user", content: message },
    ];

    const finalAnswer = await runAgenticLoop(messages, send, 5);

    for (const char of finalAnswer) {
      send({ type: "token", token: char });
    }

    send({ type: "done" });
    res.end();
  } catch (err) {
    console.error(`[RESEARCH CHAT] Error: ${err.message}`);
    send({ type: "error", error: err.message });
    res.end();
  }
});

module.exports = router;