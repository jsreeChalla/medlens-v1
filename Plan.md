# MedLens — Plan

This is a working document. It tracks what's done, what's next, and where the project is headed.

---

## Current State (v1.1)

The core loop works end-to-end:

- Search a drug by name (generic, brand, or Indian trade name)
- Get a plain-English profile with side effects, interactions, manufacturers, dosage, and NPPA pricing
- Ask follow-up questions in the embedded chat

Deployed on Render. Live at: https://medlens-v1.onrender.com

### Shipped in v1.1

- [x] **Playfair Display typography** — replaced Syne with Playfair Display across all display headings; more trustworthy visual register for a medical tool
- [x] **Special populations redesign** — dosageDetails string parsed into emoji-icon bullet cards with automatic status badges (✓ No Adjustment / ⚠ Adjust Dose / 🚫 Not Recommended)
- [x] **Pregnancy risk moved to sidebar** — FDA category legend (A–X) with current drug highlighted; removed from Dosage tab where it created visual noise
- [x] **Mobile responsiveness** — three breakpoints: ≤768px (tablet), ≤400px (small phone), touch device tap target enforcement (44px minimum)

---

## Phase 1 — Stability & Trust (Active)

These are the highest-leverage fixes before showing the product to anyone important.

### P1 — Must do

- [ ] **Fuzzy name matching** — A typo returns not-found. A Levenshtein distance check or phonetic match against `indian_brands.js` would fix the most common failure mode.
- [ ] **NPPA data refresh** — Current data is DPCO 2022. Source the latest available list and update `nppa_prices.json`.
- [ ] **Cold start UX** — Render free tier spins down. Show a "waking up the server…" message with a longer timeout instead of failing silently.
- [ ] **Input sanitisation hardening** — Current gibberish guard is heuristic. Add a minimum character check and block pure numeric inputs.

### P2 — Should do

- [ ] **Extend `indian_brands.js`** — 306 entries currently. Audit for the most commonly prescribed drugs in India and fill gaps.
- [ ] **Error message specificity** — Generic "Something went wrong" is not useful. Route Groq errors, parse errors, and network errors to distinct messages.
- [ ] **Chat disclaimer in panel** — Add a visible note in the chat panel that the AI can be wrong and a doctor should be consulted.

---

## Phase 2 — Doctor Use Case (Next)

Doctors want to use MedLens during consultations to help patients understand their prescriptions. The current feature set is already right for this — the gap is making it usable in a consultation context.

### P1 — Shareable patient summary

A "Share with patient" button on the drug header that generates a clean, printable or linkable view containing only:

- Plain-English summary
- Side effects (Major and Moderate only, with descriptions)
- Dosage instruction
- NPPA price
- Medical disclaimer

No tabs, no chat, no technical data. A patient can screenshot it or receive it as a link before leaving the room.

This is the highest-value addition for the doctor use case. Everything else depends on whether doctors actually use this.

### P2 — Doctor's note field

Optional text area the doctor fills before sharing. Pre-pended to the shared summary as a personalised note: "Take this with your morning meal" or "We're trying this for 3 months first."

Turns MedLens from a reference tool into a communication tool.

### P3 — Mobile polish pass

The ≤768px breakpoint is functional but not refined. A targeted pass specifically testing on a 6-inch Android screen (the most common doctor phone in India) to catch any remaining layout issues:

- Verify tab scrolling doesn't clip at narrow widths
- Test chat input behaviour when keyboard opens (viewport resize)
- Verify special population cards don't overflow on long dosage strings

---

## Phase 3 — Data Quality

The biggest gap in v1 is that all drug data is LLM-generated. This is acceptable for a prototype. It is not acceptable if doctors are sharing this with patients.

### OpenFDA Integration

OpenFDA provides a free, open drug database via REST API. Plan:

1. On each drug search, call OpenFDA in parallel with the Groq call
2. Use OpenFDA data for: drug class, approved uses, warnings, structured interactions
3. Feed OpenFDA structured data into the LLM prompt as context (RAG pattern)
4. LLM's job narrows to: Indian context, plain-English rendering, brand information

This is the single biggest accuracy improvement available without any licensing cost. It is also a prerequisite before marketing MedLens to doctors.

```
Input name
    │
    ├── OpenFDA lookup (parallel)    ← clinical facts
    └── indian_brands map            ← Indian context
              │
              ▼
        Groq (llama-3.1-8b-instant)
        [system: here is the clinical data, render this for a lay Indian reader]
              │
              ▼
        DrugProfile (grounded)
```

### NPPA Live Integration

- Automate a weekly check against the NPPA website for new price lists
- Parse and update `nppa_prices.json` automatically
- Surface update date in the UI ("Prices as of [date]")

---

## Phase 4 — Feature Expansion

In rough priority order, after data quality is addressed:

### Multi-drug interaction checker

A patient on five medications can't check each pair individually.

- Input: list of 2–10 drugs
- Output: interaction matrix, severity-highlighted
- Implementation: either per-pair LLM calls or a single prompt with all drugs listed

### Indian language support

Most impactful accessibility change for Indian users. Hardest to do well.

- Drug summaries in Indian languages require culturally appropriate health communication, not just translation
- Option A: post-process English output through a translation model
- Option B: extend the prompt to produce English and other Indian language simultaneously (lower latency, likely higher quality)
- Evaluate with native speakers before shipping

### Prescription photo OCR

Photograph a prescription → auto-fill the drug search.

- Vision model (GPT-4V or similar) for OCR + drug name extraction
- Handle messy handwriting, multiple drugs per prescription
- Privacy: process client-side where possible; never store images

---

## Phase 5 — Platform

Only relevant once there is a meaningful user base.

### User accounts + medication list

- Save a list of current medications
- Proactively flag interactions between saved drugs
- Track dosage schedule

### DigiLocker / ABHA integration

- Pull prescription history from DigiLocker
- Connect to ABHA (Ayushman Bharat Health Account)
- Requires government API access; dependent on ABDM partnerships

### Clinician mode

Separate product layer for doctors who want to use MedLens as a reference tool, not just a patient communication aid. Requires:

- Full PK/PD data (half-life, bioavailability, protein binding, metabolism pathway)
- CYP450 substrate / inhibitor / inducer data
- Monitoring parameters
- Guideline references and evidence grades
- Different chat prompt persona (peer-level, no hedging)

This is only viable after OpenFDA grounding is in place. LLM-generated clinical data is not acceptable for practitioners.

### Biomedical model evaluation

Current model (llama-3.1-8b-instant) is general-purpose. Evaluate:

- BioMistral-7B — fine-tuned on biomedical literature
- Meditron-7B — medical domain LLM from EPFL

Evaluation criteria: accuracy on drug fact questions, hallucination rate, Indian drug coverage, latency on Groq-equivalent infrastructure.

---

## Open Questions

**Data accuracy obligation** — At what point does "informational purposes only" become insufficient? If doctors are actively sharing MedLens content with patients during consultations, the accuracy bar goes up significantly. OpenFDA grounding should precede any active marketing to medical professionals.

**Shareable summary and liability** — A shared URL with drug information could be screenshotted, forwarded, taken out of context. The disclaimer must travel with the content. How this works technically (static URL vs generated view) affects the design.

**Monetisation** — Free tier Render is fine for prototyping. Sustained traffic requires a paid plan. Options: subscription, freemium with an API tier, institutional licensing to healthcare NGOs or hospital systems.

**Scope creep risk** — The roadmap is long. The core value (one drug, plain English, Indian context) must remain primary. Every new surface is another place the model can hallucinate.

---