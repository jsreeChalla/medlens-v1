# MedLens — Architecture

**Version:** 1.1  
**Stack:** Node.js / Express · Vanilla JS · Groq API · Render

---

## Changelog

| Version | Change |
|---|---|
| 1.1 | Mobile breakpoints added; special populations parser; pregnancy risk moved to sidebar; font stack updated to Playfair Display |
| 1.0 | Initial version |

---

## 1. System Overview

```
Browser
  │
  ├── GET  /                      → index.html (static)
  ├── POST /api/consumer/drug     → Drug profile (SSE)
  ├── POST /api/chat              → AI chat (SSE streaming)
  └── GET  /api/health            → Status check
          │
          ▼
    Express Server (Node.js)
          │
          ├── indian_brands.js    (in-memory lookup map)
          ├── nppa_prices.json    (in-memory NPPA ceiling prices)
          │
          └── Groq API  ──→  llama-3.1-8b-instant
```

Both primary endpoints use **Server-Sent Events (SSE)** — the server pushes data over a regular HTTP connection without WebSockets. This gives the frontend progress feedback during drug lookup and word-by-word streaming in chat, without requiring a persistent socket connection.

---

## 2. Directory Structure

```
medlens-v1/
├── server/
│   ├── server.js           Main Express app + all API routes
│   ├── indian_brands.js    Brand → generic name map (306 entries)
│   └── nppa_prices.json    DPCO 2022 ceiling price data
│
└── frontend/
    └── index.html          Entire frontend — single file
```

---

## 3. Frontend Architecture

Single `index.html`. No framework, no bundler, no build step.

### Typography

Three Google Fonts loaded in a single import:

| Font | Role |
|---|---|
| Playfair Display (400, 600, 700) | Display — logo, headings, drug name, manufacturer brand, chatbot title |
| DM Sans (300–600, italic) | Body — all prose, inputs, buttons |
| DM Mono (400, 500) | Monospace — labels, badges, pills, prices, dates |

### Responsive Breakpoints

Three CSS media query layers, no JS involved:

```
≤768px  — tablet / large phone
  Header shrinks, padding tightens to 16px, type scales down,
  manufacturer grid → single column, special population items wrap,
  chat panel shrinks, chatbot-meta hidden

≤400px  — small phone
  Server pill → dot only, drug title stacks vertically,
  badges move below drug name

hover:none + pointer:coarse  — touch devices
  All interactive elements enforced to 44px minimum tap target:
  chips, tabs, search button, chat send, disclaimer close
```

### State

All state lives in three JS variables:

```javascript
let currentDrug = null;     // DrugProfile object for the active search
let chatHistory  = [];      // Last N turns for chat context
let chatStreaming = false;   // Lock to prevent concurrent chat sends
```

### Dynamic Zone

The entire `#page` div is replaced on each state transition:

```
#page states:
  welcome     → default empty state, suggestion chips
  loading     → spinner + SSE progress label
  not-found   → error card with re-search guidance
  error       → technical error card
  drug-result → full layout (tabs + sidebar + chat)
```

### Tab System

Pure CSS `display: none / block` toggled by `switchTab(id)`. No router.  
Tab IDs: `plain`, `sideeffects`, `interactions`, `manufacturers`, `dosage`.

### Key Functions

| Function | Responsibility |
|---|---|
| `checkHealth()` | Polls `/api/health` on load, updates status pill |
| `doSearch()` | Validates input, calls `fetchConsumerSSE`, routes to render or error |
| `fetchConsumerSSE()` | Reads SSE stream from `/api/consumer/drug`, handles progress + result |
| `renderDrug(d)` | Takes DrugProfile JSON, writes the entire result DOM via template strings |
| `switchTab(id)` | Toggles active tab content |
| `sendChat()` | Manages streaming chat send, updates bubble in real time |
| `appendMsg()` | Adds a message bubble to the chat panel |
| `flattenDosage()` | Normalises dosageDetails (string / array / object) to a flat string |
| `esc()` | HTML-escapes all dynamic content before insertion |

### Special Populations Parser

Lives inside `renderDrug()` as an IIFE. Takes the flat `dosageDetails` string and emits individual population cards.

```
dosageDetails string
  e.g. "20-80mg once daily. Renal impairment: no dose adjustment. Pediatric: not recommended."
        │
        ▼
  Sentence pattern: /([A-Za-z ]{3,35}):\s*([^.]+)/g
  Splits into { label, value } pairs
        │
        ├── Each label matched against keyword map
        │     renal/kidney/egfr  →  🫘  Renal Impairment  (amber)
        │     hepatic/liver      →  🟤  Hepatic Impairment (amber)
        │     elderly/geriatric  →  👴  Elderly            (muted)
        │     pediatric/child    →  👶  Pediatric          (blue)
        │     pregnan/lactat     →  🤰  Pregnancy          (muted)
        │     food/meal          →  🍽️  With Food          (teal)
        │     adult/standard     →  💊  Adult Dosing       (teal)
        │
        ├── First dose-containing sentence extracted separately
        │   as a teal-highlighted Standard Dose card
        │
        └── Status badge derived from value text
              "no dose adjustment"  →  ✓ No Adjustment  (green)
              "may be necessary"    →  ⚠ Adjust Dose    (amber)
              "not recommended"     →  🚫 Not Recommended (red)

Fallback: if sentence pattern finds nothing, splits on · delimiters
```

### Pregnancy Risk (Sidebar)

Built in `renderDrug()` from the `pregnancyCategory` field on the DrugProfile. Renders all five FDA categories (A–X) as stacked cards. The card matching `currentCat` gets a coloured border and "This drug" badge.

```javascript
const currentCat = (d.pregnancyCategory || '').toUpperCase().replace(/[^ABCDX]/g, '');
// Non-ABCDX characters stripped — guard against values like "Category B" or "B (safe)"
```

Placed in the sidebar after the Approval Timeline card, inside its own `sidebar-card` with title "Pregnancy Risk".

---

## 4. Backend Architecture

### 4.1 Drug Name Resolution

Every search goes through a two-step name resolution before hitting the LLM:

```
Input name
    │
    ▼
normalise (lowercase + trim)
    │
    ▼
indian_brands.js lookup  ──found──→  use mapped generic name  ──→  LLM call
    │
  not found
    │
    ▼
RxNorm API lookup (rxnav.nlm.nih.gov)
    │
    ├── found  →  use RxNorm canonical name  ──→  LLM call
    └── not found  →  400 "Medicine not recognised"
```

`indian_brands.js` covers generic names, branded names, and combination drugs (e.g. `pan-d → pantoprazole + domperidone`). It is the sole reason combination Indian drugs resolve correctly — RxNorm doesn't handle them.

### 4.2 Drug Profile Endpoint (`POST /api/consumer/drug`)

```
Request:  { name: "Metformin" }

Flow:
  1. Resolve drug name (brands map → RxNorm)
  2. Inject resolved name into CONSUMER_SYSTEM_PROMPT
  3. Call Groq (llama-3.1-8b-instant, response_format: json_object)
  4. Parse JSON response
  5. Attach NPPA ceiling prices from nppa_prices.json
  6. Strip manufacturer prices (LLM pricing not trusted)
  7. Stream result over SSE

SSE events:
  data: {"progress": 20}
  data: {"done": true, "result": { ...DrugProfile }}
  data: {"error": "..."}
```

**Hallucination guard (frontend):** If `name === "medicine name"` or `genericName === "salt name"` or `drugClass` starts with `"e.g."`, treated as not-found — never rendered.

### 4.3 NPPA Price Lookup

```javascript
function getNppaPrices(drugName) {
  // 1. Exact key match on lowercase name
  // 2. Partial match: result key includes first word of drug name
  // 3. Returns null if not found
  // 4. Deduplicates by dosageForm at query time
}
```

Static JSON file, DPCO 2022 data. Absent = "Not under NPPA price control."

### 4.4 Chat Endpoint (`POST /api/chat`)

```
Request:
  {
    message: "Is it safe with alcohol?",
    drugContext: "Metformin",
    history: [...last 8 turns]
  }

Flow:
  1. Append drugContext to RESEARCH_SYSTEM_PROMPT
  2. Build messages: [system, ...history, user]
  3. Groq stream: true
  4. Forward tokens over SSE

SSE events:
  data: {"token": "Taking "}
  data: {"token": "Metformin..."}
  data: {"done": true}
  data: {"error": "..."}
```

History capped at 8 turns client-side before sending.

---

## 5. LLM Prompt Design

### Consumer Prompt (Drug Profile)

- Single structured JSON schema embedded in the prompt
- `%medicine%` placeholder replaced with resolved drug name
- Requests: Indian brand names, INR pricing context, plain English, severity-tiered side effects, `dosageDetails` as a **single plain string** (not object, not array)
- `response_format: { type: "json_object" }` forces JSON-only output
- Temperature: 0.1 (factual accuracy over creativity — lower = less hallucination variance)
- Max tokens: 1600

### Research Prompt (Chat)

- Restricts to pharmacology and medicine questions
- Hard-coded off-topic refusal: `"I'm MedLens AI. I can only answer questions about medicines and pharmacology."`
- Instructs: cite mechanism, PK/PD, flag interactions; end safety answers with professional consultation note
- Temperature: 0.3 (natural conversation while staying conservative on medical claims)
- Max tokens: 1024

---

## 6. Data Flow Diagram

```
User types drug name
        │
        ▼
  doSearch() validates input
        │
        ▼
  showLoading() → #page = spinner
        │
        ▼
  fetchConsumerSSE()
   POST /api/consumer/drug
        │
   SSE progress events → update loading label
        │
   SSE done event
        │
        ├── error / placeholder detected → showNotFound()
        └── valid DrugProfile
                │
                ▼
          renderDrug(data)
           ├── drug-header-card (name, class, badges)
           ├── tabs
           │    ├── Overview (plain summary, mechanism, conditions, warnings)
           │    ├── Side Effects (severity-grouped cards)
           │    ├── Interactions (severity rows)
           │    ├── Manufacturers (brand grid)
           │    └── Dosage (standard dose card + special populations parser)
           ├── chatbot panel (seeded with drug context)
           └── sidebar
                ├── Quick Facts
                ├── Approval Timeline
                └── Pregnancy Risk (FDA A–X legend, current drug highlighted)
```

---

## 7. Infrastructure

| Concern | Solution |
|---|---|
| Hosting | Render free tier (web service) |
| Deploy trigger | Push to `main` branch (auto-deploy) |
| Environment config | `GROQ_API_KEY` as Render env var |
| Cold starts | Free tier spins down after inactivity (~30s delay) |
| Rate limiting | `express-rate-limit`: 60 requests/min on `/api/` |
| CORS | Open (`origin: "*"`) — public read-only API |
| Static files | Express serves `../frontend/` as static |

---

## 8. Design Decisions & Trade-offs

| Decision | Rationale |
|---|---|
| Single `index.html` | Faster deploys, zero build tooling, easier maintenance at this scale |
| SSE over WebSockets | Simpler server code, works over standard HTTP, sufficient for one-directional streaming |
| Groq over local Ollama | 8GB M2 RAM constrained local inference; Groq free tier is fast and reliable enough |
| LLM-generated drug data | No licensed database access; acceptable for v1 with disclaimers |
| Indian brands map as validation shortcut | RxNorm doesn't know Pan-D; local map solves Indian combination drug gap |
| Client-side chat history | No session storage needed; history reset on new drug search is acceptable |
| NPPA as static JSON | Last available data is 2022; live API doesn't exist; static file is honest and controllable |
| Playfair Display over Syne | Serif display font reads as more trustworthy for medical context; Syne is tech-branded, Playfair is clinical-adjacent |
| Special populations as parsed cards | Flat string is what the model reliably returns; parsing client-side avoids prompt schema changes and keeps the model contract simple |
| Pregnancy risk in sidebar | It's reference information, not the primary result — sidebar is the right information hierarchy position; Dosage tab should focus on actionable dosing instructions |
| CSS-only mobile responsiveness | No JS breakpoint logic needed; CSS media queries handle all three breakpoints cleanly without framework overhead |

---