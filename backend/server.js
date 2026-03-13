require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const indianBrands = require("./indian_brands");
const nppaPrices = require("./nppa_prices.json");
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
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// Also, tell Express to serve CSS/JS/Images from the frontend folder
app.use(express.static(path.join(__dirname, "../frontend")));

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
  "indianManufacturers": [
    {"brand":"...","manufacturer":"...","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","strength":"XXmg","type":"tablet"},
    {"brand":"...","manufacturer":"...","strength":"XXmg","type":"tablet"}
  ],
  "dosageSimple": "e.g. 20mg once daily after food",
  "dosageDetails": "single string: adult dose, timing, food, renal, hepatic, elderly, pediatric",
  "canBuyWithout": false,
  "fdaApproved": true,
  "whoEssential": true,
  "genericAvailable": true,
  "pregnancyCategory": "B",
  "controlled": false,
  "knownInteractionsCount": 0,
  "approvalTimeline": [
    {"event":"First clinical trials","year":"1957"},
    {"event":"FDA Approval","year":"March 1994"},
    {"event":"Generic versions approved","year":"2002"},
    {"event":"WHO Essential Medicines List","year":"2007"}
  ],
  "disclaimer": "Always consult a licensed doctor or pharmacist."
}

RULES:
1. sideEffects severity: MAJOR / MODERATE / MINOR only
2. approvalTimeline: real years only, never placeholder text
3. dosageDetails: single plain string, not object or array
4. indianManufacturers: 5 real Indian brands ordered most available first
5. No text outside the JSON object`;

const RESEARCH_SYSTEM_PROMPT = `You are MedLens AI — a clinical pharmacology assistant.

Answer ONLY questions about medicines, drug interactions, pharmacology, and clinical topics.
For anything off-topic respond exactly: "I'm MedLens AI. I can only answer questions about medicines and pharmacology."

Guidelines:
- Use precise pharmacological terminology
- Cite mechanism, PK/PD, and clinical evidence where relevant
- Distinguish FDA-approved vs off-label uses explicitly
- Flag major drug interactions and contraindications prominently
- End safety-critical answers with: "Consult a licensed healthcare professional before making clinical decisions."
- Do not prescribe, diagnose, or give personal medical advice`;

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
async function getDrugName(name) {
  try {
    
    const normalised = name.toLowerCase().trim();
    const mapped = indianBrands[normalised];
    console.log(`[DRUG NAME] "${name}" → "${mapped || 'unknown'}"`);
    // Brand found — return directly, skip RxNorm
    if (mapped) return mapped;

    // Unknown brand — try RxNorm
    const rxRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(name.trim())}&search=1`
    );
    const rxData = await rxRes.json();
    const rxcui = rxData.idGroup?.rxnormId?.[0];
    if (!rxcui) return null;

    const nameRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/property.json?propName=RxNorm%20Name`);
    const nameData = await nameRes.json();
    return nameData.propConceptGroup?.propConcept?.[0]?.propValue || name.trim();

  } catch (err) {
    console.error(err.message);
    return null;
  }
}

function getNppaPrices(drugName) {
  const key = drugName.toLowerCase().trim();
  let data = nppaPrices[key];
  if (!data) {
    const partialKey = Object.keys(nppaPrices).find(k => 
      key.includes(k) || k.includes(key.split(" ")[0])
    );
    data = partialKey ? nppaPrices[partialKey] : null;
  }
  if (!data) return null;
  // Deduplicate by dosageForm
  const seen = new Set();
  return data.filter(p => {
    if (seen.has(p.dosageForm)) return false;
    seen.add(p.dosageForm);
    return true;
  });
}

app.post("/api/consumer/drug", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const drugName = await getDrugName(name);
  if (!drugName) {
    return res.status(400).json({ error: "Medicine not recognised. Please check the spelling and try again." });
  }
  console.log(`[CONSUMER] "${drugName}" → Groq (${GROQ_MODEL})`);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const prompt = CONSUMER_SYSTEM_PROMPT.replace(/%medicine%/g, drugName);
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

    if (result.indianManufacturers) {
  result.indianManufacturers = result.indianManufacturers.map(m => ({
    ...m,
    pricePerStrip: null
  }));
}
result.avgMonthlyCostINR = null;

// Attach verified NPPA ceiling prices
const nppData = getNppaPrices(drugName);
result.nppaCeilingPrices = nppData || null;
result.nppaPriceDisclaimer = nppData
  ? "Government ceiling prices per NPPA DPCO 2022. No manufacturer may legally charge above these rates."
  : "This drug is not under NPPA price control. Prices vary by manufacturer and pharmacy.";

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n💊 MedLens API running at http://localhost:${PORT}`);
  console.log(`   Consumer : Groq → ${GROQ_MODEL}  ← /api/consumer/drug`);
  console.log(`   Chat     : Groq → ${GROQ_MODEL}  ← /api/chat`);
  console.log(`   ✓ Ready\n`);
});