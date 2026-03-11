// server.js — Drug Research API (Node.js + Ollama + BioMistral)
// Run: node server.js
// Requires: npm install express cors axios express-rate-limit dotenv

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.MODEL || "biomistral";

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60_000, max: 30, message: { error: "Too many requests" } });
app.use("/api/", limiter);

// ── System prompts ──────────────────────────────────────────────────────────

// For doctors / advanced queries
const SYSTEM_PROMPT = `You are a specialized biomedical research assistant.
Provide accurate, evidence-based information about drugs, compounds, mechanisms of action,
pharmacokinetics, drug interactions, clinical trials, and medical literature for %medicine%.

Guidelines:
- Always cite relevant medical knowledge and studies when possible
- Clearly distinguish between approved uses and experimental/off-label uses
- Flag potential drug interactions and contraindications prominently
- Use standard pharmacological terminology
- Include relevant molecular/biochemical details when appropriate
- For any safety-critical information, recommend consulting a licensed healthcare professional
- Structure responses clearly with sections when the answer is complex

You do NOT provide personal medical advice or prescriptions.`;

// For consumer-friendly structured drug info
const CONSUMER_SYSTEM_PROMPT = `You are a JSON API. You only output valid JSON, nothing else — no greetings, no explanations, no markdown fences.

The user needs structured information about %medicine%, respond with ONLY this JSON structure filled in completely. 
Below is sample structure for the response, but you must fill in all fields with real information about the medicine. 
Do not leave any field empty or with placeholder text.
Summerize the plainEnglishSummary to a few lines while informating the user the severity of the condition it treats and how it helps.
Limit the manufacturer list to 5 real Indian brands with realistic prices.
Do not repeat the same brand with different or same prices.
Summarize the warnings, usedFor conditions and common side effects in a couple of sentences, do not list every single warning, condition or side effect from the leaflet, just the most important and severe ones that a consumer should be aware of.
If certain information is not available, use "Not available" or a similar phrase, but do not omit any field.

{
  "name": "the medicine name",
  "genericName": "generic or salt name",
  "plainEnglishSummary": "2-3 sentences explaining what this medicine does in simple words a teenager would understand",
  "usedFor": ["condition 1", "condition 2", "condition 3"],
  "howItWorks": "one simple sentence, no medical jargon",
  "sideEffects": {
    "common": ["side effect 1", "side effect 2", "side effect 3"],
    "serious": ["serious side effect 1", "serious side effect 2"]
  },
  "interactions": [
    { "drug": "drug name", "effect": "what happens if combined" },
    { "drug": "drug name", "effect": "what happens if combined" }
  ],
  "warnings": ["warning 1", "warning 2"],
  "indianManufacturers": [
    { "brand": "Brand Name", "manufacturer": "Company Name", "pricePerStrip": "₹XX", "strength": "XXmg", "type": "tablet" },
    { "brand": "Brand Name", "manufacturer": "Company Name", "pricePerStrip": "₹XX", "strength": "XXmg", "type": "tablet" },
    { "brand": "Brand Name", "manufacturer": "Company Name", "pricePerStrip": "₹XX", "strength": "XXmg", "type": "tablet" }
  ],
  "dosageSimple": "simple dosage instructions a patient can follow",
  "canBuyWithout": true,
  "disclaimer": "Always consult a doctor before taking any medicine."
}

Rules:
- Output ONLY the JSON object. First character must be { and last must be }
- indianManufacturers must have 5-8 real Indian brands with realistic rupee prices
- Keep language simple enough for a 14-year-old
- Never add text before or after the JSON`;


// ── Routes ──────────────────────────────────────────────────────────────────

// Health check + Ollama connectivity
app.get("/api/health", async (req, res) => {
  try {
    const ollamaRes = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 3000 });
    const models = ollamaRes.data.models?.map((m) => m.name) || [];
    const biomistralReady = models.some((m) => m.toLowerCase().includes("biomistral"));
    res.json({
      status: "ok",
      ollama: "connected",
      models,
      biomistralReady,
      activeModel: MODEL,
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      ollama: "unreachable",
      error: err.message,
      hint: "Make sure Ollama is running: `ollama serve`",
    });
  }
});

// List available models
app.get("/api/models", async (req, res) => {
  try {
    const { data } = await axios.get(`${OLLAMA_BASE_URL}/api/tags`);
    res.json({ models: data.models || [] });
  } catch (err) {
    res.status(503).json({ error: "Cannot reach Ollama", detail: err.message });
  }
});

// Main research query — streaming
app.post("/api/research/stream", async (req, res) => {
  const { query, model = MODEL, history = [] } = req.body;

  if (!query?.trim()) return res.status(400).json({ error: "query is required" });
  const sys_prompt = SYSTEM_PROMPT.replace("%medicine%", query.trim());
  // Build message history
  const messages = [
    { role: "system", content: sys_prompt },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: query },
  ];

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const ollamaRes = await axios.post(
      `${OLLAMA_BASE_URL}/api/chat`,
      { model, messages, stream: true },
      { responseType: "stream", timeout: 120_000 }
    );

    let buffer = "";

    ollamaRes.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const token = parsed.message?.content || "";
          if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
          if (parsed.done) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch (_) {}
      }
    });

    ollamaRes.data.on("end", () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

    ollamaRes.data.on("error", (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    const hint =
      err.code === "ECONNREFUSED"
        ? "Ollama is not running. Start it with: ollama serve"
        : err.response?.status === 404
        ? `Model '${model}' not found. Pull it with: ollama pull ${model}`
        : err.message;
    res.write(`data: ${JSON.stringify({ error: hint })}\n\n`);
    res.end();
  }
});

// Non-streaming research query
app.post("/api/research", async (req, res) => {
  const { query, model = MODEL, history = [] } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: "query is required" });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: query },
  ];

  try {
    const { data } = await axios.post(
      `${OLLAMA_BASE_URL}/api/chat`,
      { model, messages, stream: false },
      { timeout: 120_000 }
    );
    res.json({
      response: data.message?.content || "",
      model: data.model,
      totalDuration: data.total_duration,
    });
  } catch (err) {
    const status = err.code === "ECONNREFUSED" ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Consumer drug search — format:json forces valid JSON output ─────────────
app.post("/api/consumer/drug", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  const prompt = CONSUMER_SYSTEM_PROMPT.replace("%medicine%", name.trim());

  try {
    const ollamaRes = await axios.post(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        model: MODEL,
        prompt,
        stream: true,
        format: "json",
        options: { temperature: 0.1, num_ctx: 4096, num_predict: 2048 },
      },
      { responseType: "stream", timeout: 300_000 }
    );

    let fullText = "";
    let buffer = "";

    await new Promise((resolve, reject) => {
      ollamaRes.data.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            fullText += parsed.response || "";
          } catch {}
        }
      });
      ollamaRes.data.on("end", resolve);
      ollamaRes.data.on("error", reject);
    });

    console.log("[DEBUG] output:", fullText.slice(0, 200));

    try {
      res.json(JSON.parse(fullText));
    } catch {
      res.status(500).json({ error: "Model returned non-JSON", raw: fullText });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧬 Drug Research API running at http://localhost:${PORT}`);
  console.log(`   Ollama endpoint : ${OLLAMA_BASE_URL}`);
  console.log(`   Active model    : ${MODEL}`);
  console.log(`\n   Setup checklist:`);
  console.log(`   1. ollama serve`);
  console.log(`   2. ollama pull biomistral`);
  console.log(`   3. node server.js\n`);
});