# MedLens

**Drug research tool built for Indian patients — not clinicians.**

Medlens is a drug research tool. The intention was to create a tool that would help general public who don't have any medical training:

- Understand what a certain medicine does
- Understand why the patient should follow the instructions that a doctor mentioned
- Know the seriousness of the side effects and how common or uncommon they are
- Know the cap over the medicine/drug that the Government has placed
- Ask follow up questions in the chat


Live on Render: *(https://medlens-v1.onrender.com/)*
Repo: *(https://github.com/jsreeChalla/medlens-v1)*

---

## Tech stack

| Layer | What |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — single file, no framework |
| Backend | Node.js + Express |
| AI model | Groq API (`llama-3.1-8b-instant`) |
| Hosting | Render (free tier) |

The frontend is a single `index.html`. It helped with faster deployments and less stressful maintenance. 

The original prototype used Ollama running locally. That worked for development. Helped in understanding the SLMs and LLMs well. Took a call to move to Groq to improve speed and efficiency. Deploying a SLM on a free tier Render would be too complicated at this stage.

---

## How it works

```
Browser
  └── POST /api/consumer/drug  ──→  Express server  ──→  Groq API
         (drug search, SSE)                                (llama-3.1-8b-instant)
  └── POST /api/chat           ──→  Express server  ──→  Groq API
         (chat, SSE streaming)
```

Both endpoints use Server-Sent Events (SSE) — a way for the server to push data to the browser over a regular HTTP connection, without needing WebSockets. For the drug search, this means progress updates stream in while the LLM is working so the user sees something happening. For chat, it gives the word-by-word streaming effect.

### Drug search endpoint (`POST /api/consumer/drug`)
This endpoint takes a drug name, runs it through some basic validation (to avoid wasting a Groq call on gibberish), then prompts the LLM to return a structured JSON object with everything the frontend needs.

The prompt is opinionated — it explicitly asks for Indian brand names, INR pricing, plain English that a non-medical reader can understand, and side effects grouped by severity. Getting consistent JSON out of the model took some iteration; I ended up needing to be very explicit about the schema and add detection on the frontend for when the model leaks the prompt template into the output instead of filling it.

**Request**
```json
{ "name": "Metformin" }
```

**SSE stream — what comes back**
```
data: {"progress": 20}
data: {"progress": 60}
data: {"done": true, "result": { ...DrugProfile }}
```

If the drug isn't found or the output looks like a hallucination, the frontend catches it and shows a not-found state.

### Indian brand logic

There's a pre-loaded list of Indian drug names on the backend. The list covers generic names, brand names, and combination drugs (e.g. Pan-D, which is pantoprazole + domperidone). When a search comes in, the name is checked against this list first.

- **If found in the list** — the drug is treated as valid and the LLM call is made directly to generate the full profile, including Indian manufacturer cards. The name validity check is skipped.
- **If not found in the list** — the input goes through the standard validation step before hitting the LLM.

The Indian manufacturer data itself (brand name, manufacturer, strength, form) is entirely LLM-generated — the list is only used for the validation shortcut, not as a data source.

### Chat endpoint (`POST /api/chat`)

The system prompt tells the model what drug is currently loaded and feeds it the full drug profile JSON so it's answering from structured data rather than free-associating.

History is maintained client-side and sent with each request (last 8 turns). The model is instructed to be conservative — flag uncertainty, recommend seeing a doctor, never diagnose or prescribe.

**Request**
```json
{
  "message": "Is it safe to take this with alcohol?",
  "drugContext": "Metformin",
  "history": [...]
}
```

Tokens stream back one by one:
```
data: {"token": "Taking "}
data: {"token": "Metformin "}
data: {"token": "with alcohol..."}
data: {"done": true}
```

### Health check (`GET /api/health`)

```json
{ "status": "ok", "groqEnabled": true, "groqModel": "llama-3.1-8b-instant" }
```

The frontend polls this on load and shows a status pill in the header so users know if the backend is up.

---

## Data model

The core object everything is built around:

```typescript
interface DrugProfile {
  name: string
  genericName: string
  brandName?: string
  drugClass: string
  category?: string

  plainEnglishSummary: string       // what the drug does, ≤4 sentences
  howItWorks: string                // mechanism of action, plain language
  usedFor: string[]

  warnings: string[]

  sideEffects: SideEffect[]
  interactions: DrugInteraction[]
  knownInteractionsCount?: number

  indianManufacturers: Manufacturer[]
  nppaCeilingPrices: NPPAPrice[]
  nppaPriceDisclaimer?: string

  dosageSimple: string
  dosageDetails?: string | object

  approvalTimeline: TimelineEvent[]

  whoEssential: boolean
  genericAvailable: boolean
  pregnancyCategory?: string        // A / B / C / D / X
  controlled: boolean
  canBuyWithout: boolean            // true = OTC (no prescription needed), false = prescription required
  fdaApproved?: boolean
}

interface SideEffect {
  name: string
  severity: 'MAJOR' | 'MODERATE' | 'MINOR'
  description?: string
  frequency?: string
}

interface DrugInteraction {
  drug: string
  effect: string
  severity: 'MAJOR' | 'MODERATE' | 'MINOR'
}

interface Manufacturer {
  brand: string
  manufacturer: string
  strength: string
  type?: string    // tablet | capsule | syrup | injection
}
```

---

## Frontend

Single `index.html`. The `#page` div is the dynamic zone — it gets replaced entirely depending on state:

- **Welcome** — default empty state
- **Loading** — spinner + SSE progress messages
- **Error / Not found** — with re-search guidance
- **Drug result** — the full layout with tabs + sidebar + chat

The tab system is just CSS `display: none / block` toggled by a `switchTab()` function. No router, no state management library.

CSS uses custom properties on `:root` for the entire color system. Dark theme, teal accent for primary actions, amber for warnings, red/green for severity indicators.

Key JS functions:

```
checkHealth()       — runs on page load, updates status pill
doSearch()          — validates input, calls fetchConsumerSSE, renders result
fetchConsumerSSE()  — reads SSE stream from /api/consumer/drug
renderDrug()        — takes DrugProfile JSON, writes entire result DOM
sendChat()          — manages streaming chat, updates bubble in real time
```

---

## Running locally

```bash
npm install
export GROQ_API_KEY=your_key_here
npm start
# → http://localhost:3000
```

You'll need a Groq API key. Free tier works fine for development.

---

## Deploying to Render

1. Push to GitHub
2. New Web Service on Render, connect the repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `GROQ_API_KEY` as an environment variable
6. Deploy

Render auto-deploys on push to `main`. Free tier spins down after inactivity which causes a cold start delay — worth noting for demos.

---

## Honest limitations

**Pricing data isn't real.** The LLM generates approximate Indian prices based on its training data. It's usually in the right ballpark but it's not pulled from any live database.

**All data is LLM-generated.** This means it's only as accurate as the model's training data, which has a knowledge cutoff and can hallucinate. I've added a few layers to catch obvious hallucinations (placeholder detection, input validation, price anchoring in the prompt) but it's not foolproof. The idea is to feed the model the real world medical information on drugs, studies on them, any news on the manufacturers. The next steps would be to zero in on the right datasources for the training through RAG.

**No multi-drug interaction checking.** Right now you can only look up one drug at a time. If someone is on five medications, they'd have to check each one separately. 

**English only.** Which cuts out a huge chunk of potential users in India. Hindi support is something I want to add but it's not trivial to do well with the current architecture.

---

## Roadmap

- **OpenFDA integration** — use FDA's open drug database as a RAG source for more grounded data, supplemented by LLM for Indian context. This is the biggest accuracy improvement available right now.
- **NPPA price integration** — the last available pricelist is from 2022. The database is currently a JSON file.
- **Fuzzy drug name matching** — right now a typo returns not-found; should handle common misspellings
- **Multi-drug interaction checker** — enter multiple drugs, flag conflicts
- **Prescription photo OCR** — photograph a prescription, auto-fill the search

Longer term:
- Evaluate biomedical fine-tuned models (BioMistral, Meditron) for better clinical accuracy
- User accounts with saved medication list
- DigiLocker / ABHA integration

---

## Disclaimer

MedLens is for informational purposes only. 

The app does not collect personal data. Search queries and chat messages are processed by Groq's API.

---