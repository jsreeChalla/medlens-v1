# MedLens — Rules

Ground rules for working on this codebase. Covers code style, LLM prompt behaviour, data handling, and what not to break.

---

## 1. Medical Disclaimer — Non-Negotiable

MedLens surfaces LLM-generated drug information to patients — and to doctors sharing that information with patients. This creates a real harm surface.

**These rules apply everywhere, always:**

- Every page surface must carry a visible medical disclaimer
- The disclaimer must be present on the sticky header banner and within the AI chat panel
- Any future shareable summary view must carry the disclaimer — it must travel with the content
- The disclaimer must reflect that MedLens is a communication aid, not a clinical reference: "MedLens is for informational purposes only. Information should be confirmed by the prescribing physician before acting on it. Not a substitute for clinical judgment."
- The chat system prompt must instruct the model to recommend professional consultation on safety-critical questions
- The chat must never diagnose, prescribe, or give personalised medical advice
- If the model returns a response that looks like a diagnosis or prescription, that is a bug
- Never remove or hide the disclaimer to improve aesthetics

---

## 2. Hallucination Prevention

LLM output must be treated as untrusted until validated.

**Frontend rules:**
- Always check for placeholder leakage: if `name === "medicine name"` or `genericName === "salt name"` or `drugClass` starts with `"e.g."`, treat as not-found — do not render
- Always run `esc()` on every piece of dynamic content before inserting into the DOM — no exceptions
- Never render raw HTML from LLM output
- `flattenDosage()` must handle string, array, and object — the model doesn't always return the same type

**Backend rules:**
- Use `response_format: { type: "json_object" }` on every drug profile call — never rely on parsing freeform LLM text as JSON
- Temperature for drug profile calls must stay at or below 0.1 — higher temperature increases hallucination variance, which is unacceptable when doctors may be sharing the output with patients
- If `JSON.parse()` throws, return an error SSE event — never return partial data

---

## 3. Indian Drug Data

The Indian brands map (`indian_brands.js`) is core infrastructure, not a convenience.

- All keys must be lowercase and trimmed
- Combination drugs (e.g. `pan-d`, `combiflam`) must map to their full generic composition
- When adding entries, check for duplicate keys — a wrong mapping silently produces wrong results
- Do not delete entries without verifying the drug is no longer in use
- RxNorm does not handle Indian combination drugs — the local map is the only reliable path for these

---

## 4. NPPA Price Data

- `nppa_prices.json` contains government ceiling prices from DPCO 2022
- Never overwrite this file with LLM-generated prices — LLM pricing is stripped before the response is returned
- The file key format is lowercase drug name; values are arrays of `{ dosageForm, ceilingPriceRs }`
- Deduplication by `dosageForm` is applied at query time — do not deduplicate in the file itself
- Always update the file metadata (date, source) when refreshing the data
- Display "Not under NPPA price control" when a drug is absent — never show a blank or zero

---

## 5. Prompt Rules

**Consumer prompt (drug profile):**
- The schema in the prompt is the contract — the frontend renders against it directly
- Never change a field name in the prompt without updating `renderDrug()` in the frontend
- `indianManufacturers` must always be asked for in priority order: most available first
- `approvalTimeline` must ask for real years only — the hallucinated placeholder `"YYYY"` pattern must remain in the negative instruction
- `dosageDetails` must be requested as a **single plain string** in `Label: value.` format — not an object, not an array. The frontend parses it client-side. Requesting an object would change the prompt contract and break the special populations parser

**Chat prompt (research):**
- The off-topic refusal phrase must stay verbatim: `"I'm MedLens AI. I can only answer questions about medicines and pharmacology."` — the frontend may check for this string
- Drug context injection must use the resolved generic name, not the brand name the user searched for
- History must be capped at 8 turns before sending to Groq

---

## 6. Frontend Rules

- `index.html` is the entire frontend — no build step, no bundler, no external JS files
- All dynamic content goes into `#page` — never manipulate other parts of the DOM from `renderDrug()`
- Tab state is CSS only — do not add JS state for tab visibility
- `switchTab()` must update both `.tab` active class and `.tab-content` active class in a single call
- Google Fonts is the only external dependency in the frontend — keep it that way
- The status pill in the header is the only health indicator — do not add a second one

**Typography rules:**
- Playfair Display is the display font — use it for: logo, hero `h1`, drug name (`.drug-h1`), welcome `h2`, manufacturer brand name (`.mfr-brand`), chatbot name (`.chatbot-name`)
- DM Sans is the body font — all prose, inputs, buttons
- DM Mono is for labels, badges, status pills, prices, dates — anything that benefits from monospace alignment
- Do not introduce a fourth font without a strong reason

**Mobile rules:**
- All interactive elements must meet 44px minimum tap target on touch devices — enforced via the `hover:none` media query
- The three breakpoints (768px, 400px, touch) must be preserved — do not consolidate them
- Never use fixed pixel widths on any element that appears inside the `#page` dynamic zone — it will break on narrow screens
- Test any new component at 375px width (iPhone SE / small Android) before merging

---

## 7. API & Server Rules

- Rate limit stays at 60 requests/min on `/api/` — do not raise this without considering abuse vectors
- CORS is open (`origin: "*"`) — this is intentional for a read-only public API; do not restrict without considering third-party use
- All SSE responses must end with either `{"done": true, "result": ...}` or `{"error": "..."}` — a stream that ends without one of these is a bug
- Never log the full drug profile response — log token count and latency only
- `GROQ_API_KEY` lives in environment variables only — never in code, never in the repo

---

## 8. What Not to Break

These things currently work. Treat them as invariants:

| Thing | Why it matters |
|---|---|
| `indian_brands.js` lookup | Combination drugs only work through this — not RxNorm |
| NPPA attachment in `server.js` | Prices are attached server-side; frontend just renders them |
| `fetchConsumerSSE()` buffer logic | SSE chunks can split across `\n\n` boundaries; the buffer handles this |
| `formatChat()` markdown rendering | Bold and italic in chat responses depend on this two-regex function |
| Pregnancy category `currentCat` extraction | Strips non-ABCDX characters — handles values like "Category B" or "B (safe)" correctly; removing the guard breaks the sidebar highlighting |
| Special populations sentence parser | Regex `/([A-Za-z ]{3,35}):\s*([^.]+)/g` extracts Label:value pairs; falls back to `·` splitting if no matches — both paths must be preserved |
| Special populations status badge logic | Three regex conditions map value text to green/amber/red badges; order matters (check "no adjustment" before "adjust") |
| Mobile breakpoints | Three separate `@media` blocks at 768px, 400px, and `hover:none` — do not merge them |
| Pregnancy risk sidebar card | Rendered from `pregnancyLegend` variable in `renderDrug()`; sits after the timeline card in the sidebar; must receive `pregnancyCategory` from the DrugProfile |

---

## 9. Deployment

- `main` branch deploys automatically to Render — do not push broken code to `main`
- Test drug search, special populations rendering, and chat locally before merging
- Test on a mobile viewport (375px) before merging any UI changes
- Render free tier spins down after inactivity — a 30s cold start on first request is expected and not a bug
- If the `GROQ_API_KEY` env var is missing, the server exits at startup — this is intentional

---

## 10. Out of Scope

These will not be added without explicit discussion:

- Any feature that requires storing user data or search history
- Real-time drug pricing from external paid APIs (cost, dependency risk)
- Diagnostic or triage features
- Any UI that could be mistaken for a medical records or prescription system
- A clinician mode built on LLM-only data — OpenFDA grounding must come first
- Removing the medical disclaimer from any surface, including shareable views

---