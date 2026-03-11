require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY missing in .env");
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/api/", rateLimit({ windowMs: 60_000, max: 60, message: { error: "Too many requests" } }));

// ── Prompts ───────────────────────────────────────────────────────────────────

const CONSUMER_SYSTEM_PROMPT = `You are a medical JSON API. Output ONLY valid JSON.

VALIDATION: If "%medicine%" is not a real pharmaceutical drug, output only:
{"error": "Please enter a valid medicine name."}
Invalid examples: random strings like "khfktuytouy", food names, numbe₹.

For "%medicine%" output:
{
  "name": "official name",
  "genericName": "active ingredient",
  "brandName": "top Indian brand",
  "drugClass": "pharmacological class",
  "category": "therapeutic category",
  "plainEnglishSummary": "2-3 patient-friendly sentences: condition, severity, how drug helps",
  "usedFor": ["condition 1","condition 2","condition 3","condition 4","condition 5"],
  "howItWorks": "1-2 plain sentences on mechanism",
  "sideEffects": [
    {"name":"...","severity":"MAJOR","description":"...","frequency":"e.g. Rare <1%"},
    {"name":"...","severity":"MAJOR","description":"...","frequency":"..."},
    {"name":"...","severity":"MODERATE","description":"...","frequency":"..."},
    {"name":"...","severity":"MODERATE","description":"...","frequency":"..."},
    {"name":"...","severity":"MODERATE","description":"...","frequency":"..."},
    {"name":"...","severity":"MINOR","description":"...","frequency":"..."},
    {"name":"...","severity":"MINOR","description":"...","frequency":"..."}
  ],
  "interactions": [
    {"drug":"...","severity":"MAJOR","effect":"..."},
    {"drug":"...","severity":"MAJOR","effect":"..."},
    {"drug":"...","severity":"MODERATE","effect":"..."},
    {"drug":"...","severity":"MODERATE","effect":"..."},
    {"drug":"...","severity":"MINOR","effect":"..."}
  ],
  "warnings": ["...","...","...","...","..."],
  "indianManufacture₹": [
    {"brand":"...","manufacturer":"...","pricePe₹trip":"₹ XX","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","pricePe₹trip":"₹ XX","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","pricePe₹trip":"₹ XX","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","pricePe₹trip":"₹ XX","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","pricePe₹trip":"₹ XX","strength":"XXmg","type":"tablet"}
  ],
  "dosageSimple": "e.g. 20mg once daily after food",
  "dosageDetails": "single string: adult dose, timing, food, renal, hepatic, elderly, pediatric",
  "canBuyWithout": false,
  "fdaApproved": true,
  "whoEssential": true,
  "genericAvailable": true,
  "avgMonthlyCostINR": "₹ XX-XX",
  "pregnancyCategory": "B",
  "controlled": false,
  "knownInteractionsCount": 0,
  "approvalTimeline": [
    {"event":"Fi₹t clinical trials","year":"1957"},
    {"event":"FDA Approval","year":"March 1994"},
    {"event":"Generic ve₹ions approved","year":"2002"},
    {"event":"WHO Essential Medicines List","year":"2007"}
  ],
  "disclaimer": "Always consult a licensed doctor or pharmacist."
}

RULES:
1. sideEffects severity: MAJOR / MODERATE / MINOR only
2. approvalTimeline: real yea₹ only, never placeholder text
3. dosageDetails: single plain string, not object or array
4. indianManufacture₹: 5 real Indian brands ordered cheapest fi₹t
5. avgMonthlyCostINR: based on cheapest generic × monthly doses. Real prices — Metformin 500mg: ₹ 80-150/month, Tamoxifen 20mg: ₹ 150-250/month, Atorvastatin 10mg: ₹ 80-180/month, Omeprazole 20mg: ₹ 60-120/month. Most generics are under ₹ 500/month.
6. No text outside the JSON object`;

const RESEARCH_SYSTEM_PROMPT = `You are MedLens AI — a clinical pharmacology assistant.

Answer ONLY questions about medicines, drug interactions, pharmacology, and clinical topics.
For anything off-topic respond exactly: "I'm MedLens AI. I can only answer questions about medicines and pharmacology."

Guidelines:
- Use precise pharmacological terminology
- Cite mechanism, PK/PD, and clinical evidence where relevant
- Distinguish FDA-approved vs off-label uses explicitly
- Flag major drug interactions and contraindications prominently
- End safety-critical answe₹ with: "Consult a licensed healthcare professional before making clinical decisions."
- Do not prescribe, diagnose, or give pe₹onal medical advice`;

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    groqEnabled: true,
    groqModel: GROQ_MODEL,
    consumerModel: `${GROQ_MODEL} (Groq)`,
    researchModel: `${GROQ_MODEL} (Groq)`,
    consumerModelReady: true,
    researchModelReady: true,
  });
});

// ── Consumer ──────────────────────────────────────────────────────────────────

app.post("/api/consumer/drug", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  console.log(`[CONSUMER] "${name}" → Groq (${GROQ_MODEL})`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const prompt = CONSUMER_SYSTEM_PROMPT.replace(/%medicine%/g, name.trim());
  try {
    const start = Date.now();
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1600,
      response_format: { type: "json_object" },
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const text = completion.choices[0]?.message?.content || "";
    console.log(`[GROQ] consumer done — ${completion.usage?.completion_tokens} tokens in ${elapsed}s`);
    const result = JSON.parse(text);
    result._modelUsed = GROQ_MODEL;
    result._source = "groq";
    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
    res.end();
  } catch (err) {
    console.error(`[GROQ] consumer error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { message, drugContext, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message is required" });
  console.log(`[CHAT] "${message.slice(0, 60)}" → Groq (${GROQ_MODEL})`);

  const systemMsg = RESEARCH_SYSTEM_PROMPT +
    (drugContext ? `\n\nDrug context: user is researching "${drugContext}". Answer in that context where relevant.` : "");

  const messages = [
    { role: "system", content: systemMsg },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: message },
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1024,
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || "";
      if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error(`[GROQ] chat error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n💊 MedLens API running at http://localhost:${PORT}`);
  console.log(`   Consumer : Groq → ${GROQ_MODEL}  ← /api/consumer/drug`);
  console.log(`   Chat     : Groq → ${GROQ_MODEL}  ← /api/chat`);
  console.log(`   ✓ Ready\n`);
});