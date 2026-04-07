/**
 * research_rag.js
 * ────────────────────────────────────────────────────────────────────────────
 * In-memory document store + BM25 retrieval engine for research PDFs.
 *
 * Exported API
 *   addPaper(id, title, filename, fullText, pageCount)  → paper object
 *   removePaper(id)                                     → boolean
 *   listPapers()                                        → paper[] (without chunks)
 *   searchChunks(query, topK, maxPassageWords)          → RankedChunk[]
 *   getPaper(id)                                        → paper | undefined
 *   clearAll()                                          → void
 */

// ── BM25 hyper-parameters ─────────────────────────────────────────────────────
const K1 = 1.5;   // term-frequency saturation
const B  = 0.75;  // length normalisation

// OPTIMISATION: Smaller chunks → more precise retrieval → fewer tokens sent to
// the LLM per result.  Overlap kept proportional.
const CHUNK_TOKENS   = 180;   // was 400 — tighter, more targeted passages
const CHUNK_OVERLAP  = 30;    // was 60

// Maximum words from a chunk that will ever be returned to callers.
// Callers may request fewer via the maxPassageWords argument.
const MAX_PASSAGE_WORDS = 120; // hard ceiling — ~90 tokens on average

// ── In-memory store ───────────────────────────────────────────────────────────
const papers = new Map();

// ── Tokeniser ─────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","in","on","at","to","for","of","with",
  "by","from","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "that","this","these","those","it","its","as","not","no","so","than","then",
  "when","where","who","which","what","how","all","any","both","each","few",
  "more","most","other","some","such","into","through","during","before",
  "after","above","below","between","out","off","over","under","again",
  "further","once","here","there","about","per","also","can","our","their",
]);

function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .map(lightStem);
}

function lightStem(w) {
  if (w.endsWith("ational")) return w.slice(0, -7) + "ate";
  if (w.endsWith("tional"))  return w.slice(0, -6) + "tion";
  if (w.endsWith("ization")) return w.slice(0, -7) + "ize";
  if (w.endsWith("ising"))   return w.slice(0, -5) + "ise";
  if (w.endsWith("izing"))   return w.slice(0, -5) + "ize";
  if (w.endsWith("alism"))   return w.slice(0, -5);
  if (w.endsWith("ness"))    return w.slice(0, -4);
  if (w.endsWith("ment"))    return w.slice(0, -4);
  if (w.endsWith("less"))    return w.slice(0, -4);
  if (w.endsWith("ful"))     return w.slice(0, -3);
  if (w.endsWith("ing"))     return w.length > 6 ? w.slice(0, -3) : w;
  if (w.endsWith("tion"))    return w.slice(0, -4);
  if (w.endsWith("ies"))     return w.slice(0, -3) + "y";
  if (w.endsWith("eed"))     return w.slice(0, -3) + "ee";
  if (w.endsWith("ed"))      return w.length > 5 ? w.slice(0, -2) : w;
  if (w.endsWith("ly"))      return w.length > 4 ? w.slice(0, -2) : w;
  if (w.endsWith("er"))      return w.length > 4 ? w.slice(0, -2) : w;
  if (w.endsWith("al"))      return w.length > 4 ? w.slice(0, -2) : w;
  if (w.endsWith("s") && w.length > 4) return w.slice(0, -1);
  return w;
}

// ── Chunker ───────────────────────────────────────────────────────────────────
function chunkText(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, " ").trim())
    .filter(p => p.length > 20);

  const chunks = [];
  let buffer = [];
  let bufLen = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const chunkText = buffer.join(" ");
    chunks.push(chunkText);
    const words = chunkText.split(" ");
    buffer = words.length > CHUNK_OVERLAP
      ? [words.slice(-CHUNK_OVERLAP).join(" ")]
      : [];
    bufLen = buffer.reduce((s, p) => s + p.split(" ").length, 0);
  };

  for (const para of paragraphs) {
    const paraLen = para.split(" ").length;
    if (bufLen + paraLen > CHUNK_TOKENS) flush();
    buffer.push(para);
    bufLen += paraLen;
  }
  flush();

  const finalChunks = [];
  for (const c of chunks) {
    const words = c.split(" ");
    if (words.length <= CHUNK_TOKENS + CHUNK_OVERLAP) {
      finalChunks.push(c);
    } else {
      for (let i = 0; i < words.length; i += CHUNK_TOKENS) {
        finalChunks.push(words.slice(i, i + CHUNK_TOKENS + CHUNK_OVERLAP).join(" "));
      }
    }
  }
  return finalChunks;
}

// ── BM25 index builder ────────────────────────────────────────────────────────
function buildBM25Index(rawChunks, paperId) {
  return rawChunks.map((text, i) => {
    const tokens = tokenise(text);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return { paperId, chunkIdx: i, text, tokens, tf, length: tokens.length };
  });
}

// ── Global IDF computation ────────────────────────────────────────────────────
let globalAvgLen = 0;
let globalIdf    = {};

function recomputeIdf() {
  const allChunks = getAllChunks();
  const N = allChunks.length;
  if (N === 0) { globalIdf = {}; globalAvgLen = 0; return; }

  globalAvgLen = allChunks.reduce((s, c) => s + c.length, 0) / N;

  const df = {};
  for (const c of allChunks) {
    for (const t of Object.keys(c.tf)) df[t] = (df[t] || 0) + 1;
  }
  globalIdf = {};
  for (const [t, d] of Object.entries(df)) {
    globalIdf[t] = Math.log((N - d + 0.5) / (d + 0.5) + 1);
  }
}

function getAllChunks() {
  const chunks = [];
  for (const paper of papers.values()) chunks.push(...paper.chunks);
  return chunks;
}

// ── BM25 scorer ───────────────────────────────────────────────────────────────
function bm25Score(chunk, queryTokens) {
  let score = 0;
  const avgLen = globalAvgLen || 1;
  for (const qt of queryTokens) {
    const idf = globalIdf[qt] || 0;
    if (idf === 0) continue;
    const tf  = chunk.tf[qt] || 0;
    const num = tf * (K1 + 1);
    const den = tf + K1 * (1 - B + B * (chunk.length / avgLen));
    score += idf * (num / den);
  }
  return score;
}

// ── Passage trimmer ───────────────────────────────────────────────────────────
/**
 * Return at most `maxWords` words from `text`, breaking at a sentence boundary
 * when possible so the passage reads cleanly.
 */
function trimPassage(text, maxWords = MAX_PASSAGE_WORDS) {
  const words = text.split(" ");
  if (words.length <= maxWords) return text;

  const truncated = words.slice(0, maxWords).join(" ");

  // Try to end on a sentence boundary within the last 20 words
  const sentenceEnd = truncated.search(/[.!?][^.!?]*$/);
  if (sentenceEnd > 0 && (truncated.length - sentenceEnd) < 120) {
    return truncated.slice(0, sentenceEnd + 1).trim();
  }
  return truncated.trim() + "…";
}

// ── Public API ────────────────────────────────────────────────────────────────

function addPaper(id, title, filename, fullText, pageCount = 0) {
  const rawChunks = chunkText(fullText);
  const chunks    = buildBM25Index(rawChunks, id);

  papers.set(id, {
    id, title, filename, pageCount,
    uploadedAt: new Date().toISOString(),
    charCount:  fullText.length,
    chunkCount: chunks.length,
    chunks,
  });
  recomputeIdf();

  console.log(`[RAG] Added "${title}" — ${chunks.length} chunks, ${fullText.length} chars`);
  return paperSummary(papers.get(id));
}

function removePaper(id) {
  if (!papers.has(id)) return false;
  papers.delete(id);
  recomputeIdf();
  console.log(`[RAG] Removed paper ${id}`);
  return true;
}

function listPapers() {
  return [...papers.values()].map(paperSummary);
}

function getPaper(id) {
  const p = papers.get(id);
  return p ? paperSummary(p) : undefined;
}

/**
 * BM25 retrieval across all indexed papers.
 *
 * OPTIMISATION: `maxPassageWords` caps how many words from each chunk are
 * returned.  The full chunk is only used internally for scoring; what gets
 * serialised into the tool result (and therefore into the LLM context) is
 * a trimmed, sentence-aware excerpt.
 *
 * @param {string} query
 * @param {number} topK              — number of results (default 3, was 5)
 * @param {number} maxPassageWords   — word cap per passage (default 120)
 * @param {Set<string>} [seenKeys]   — chunkId keys already sent; skip them
 * @returns {{ score, paperId, paperTitle, chunkIdx, chunkKey, text, excerpt }[]}
 */
function searchChunks(query, topK = 3, maxPassageWords = MAX_PASSAGE_WORDS, seenKeys = null) {
  const qTokens   = tokenise(query);
  const allChunks = getAllChunks();

  if (allChunks.length === 0 || qTokens.length === 0) return [];

  const scored = allChunks
    .map(c => {
      const chunkKey = `${c.paperId}:${c.chunkIdx}`;
      // OPTIMISATION: Skip chunks already delivered in this conversation turn
      if (seenKeys && seenKeys.has(chunkKey)) return null;
      return {
        score:      bm25Score(c, qTokens),
        paperId:    c.paperId,
        paperTitle: papers.get(c.paperId)?.title || "Unknown",
        chunkIdx:   c.chunkIdx,
        chunkKey,
        // OPTIMISATION: `text` is the trimmed passage sent to the LLM;
        // full chunk text is never exposed to reduce context size.
        text:       trimPassage(c.text, maxPassageWords),
        excerpt:    c.text.slice(0, 200).replace(/\s+/g, " ").trim() + "…",
      };
    })
    .filter(r => r !== null && r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

function clearAll() {
  papers.clear();
  globalIdf    = {};
  globalAvgLen = 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function paperSummary(p) {
  return {
    id: p.id, title: p.title, filename: p.filename,
    pageCount: p.pageCount, chunkCount: p.chunkCount,
    charCount: p.charCount, uploadedAt: p.uploadedAt,
  };
}

module.exports = { addPaper, removePaper, listPapers, getPaper, searchChunks, clearAll };