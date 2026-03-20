# MedLens — Product Requirements Document

**Version:** 1.1  
**Status:** Active  
**Last updated:** March 2026

---

## Changelog

| Version | Change |
|---|---|
| 1.1 | Added doctor-as-guide use case; mobile responsiveness; special populations redesign; pregnancy risk moved to sidebar |
| 1.0 | Initial version |

---

## 1. Problem Statement

When a doctor prescribes medicine in India, most patients leave the clinic without fully understanding what the drug does, why they need to take it a certain way, how serious the side effects could be, or what it should cost. Medical information online is either too clinical (written for practitioners), too generic (no Indian context), or scattered across unreliable sources.

MedLens fills this gap: a drug research tool designed for Indian patients — and for the doctors who want to help those patients understand their medication.

---

## 2. Goal

Give any Indian patient the ability to look up any medicine and come away understanding:

- What the drug is and what it treats, in plain language
- Why their doctor's instructions matter
- How serious each side effect is, and how common
- What the government price cap is (NPPA)
- Which Indian brands carry it and approximate costs
- How to ask informed follow-up questions

Give doctors a tool they can pull up during a consultation to show a patient — not to replace their clinical judgment, but to extend it beyond the 3–5 minute appointment window.

---

## 3. Users

**Primary:** Indian patients prescribed a medication who want to understand it before or after a doctor visit.

**Secondary:** Doctors using MedLens during or after a consultation to show patients clear, plain-language information about what they have been prescribed. The plain-English tone, side effect severity tiers, and NPPA pricing are already appropriate for this use case. The missing piece is mobile layout and a shareable summary.

**Tertiary:** Caregivers managing medications for a family member (elderly parents, children).

**Not the target (v1):** Clinicians using it as a clinical reference tool. MedLens is a communication aid, not a clinical decision support system. A separate clinician mode with full PK/PD data, CYP interactions, and guideline references is a future consideration — not this version.

---

## 4. Core Features (v1)

### 4.1 Drug Search
- Search by generic name, brand name, or Indian trade name
- Indian brand name list on the backend handles combination drugs (e.g. Pan-D, Combiflam) that standard drug databases miss
- Input validation to reject gibberish before burning an API call
- Not-found state with guidance to try generic name

### 4.2 Drug Profile
Structured result rendered across tabbed sections:

| Tab | Content |
|---|---|
| Overview | Plain-English summary, mechanism of action, conditions treated, warnings |
| Side Effects | Severity-tiered list (Major / Moderate / Minor) with frequency and description |
| Interactions | Drug-drug interactions with severity badges |
| Manufacturers | Indian brand cards with manufacturer, strength, form |
| Dosage | Standard adult dose + Special Populations section (see 4.3) |

### 4.3 Special Populations (Dosage Tab)
Dosage details are parsed from a flat string into individual population-specific cards, each with:

- An emoji icon identifying the population (🫘 Renal, 🟤 Hepatic, 👴 Elderly, 👶 Pediatric, 🤰 Pregnancy, 💊 Adult)
- A colour-coded label (amber for impairments, blue for pediatric, muted for pregnancy)
- The dosage instruction text inline
- An auto-derived status badge:
  - ✓ No Adjustment (green) — when text contains "no dose adjustment", "not required"
  - ⚠ Adjust Dose (amber) — when text contains "may be necessary", "caution", "reduce"
  - 🚫 Not Recommended (red) — when text contains "not recommended", "contraindicated", "avoid"

The parser handles period-separated `Label: value` format and falls back to `·`-separated segments.

### 4.4 Sidebar
- Quick facts (WHO Essential, generic availability, pregnancy category, controlled status, known interactions count)
- Approval timeline
- Pregnancy Risk card: full FDA category legend (A through X), each with a colour-coded badge, plain-English meaning, and automatic highlighting of the current drug's category with a "This drug" tag

### 4.5 NPPA Ceiling Prices
- Government-mandated price caps displayed per dosage form
- Sourced from NPPA DPCO 2022 data (JSON, updated manually)
- Disclaimer clarifying that non-NPPA drugs have variable pricing

### 4.6 AI Chat
- In-context chat with the loaded drug profile
- Streaming token-by-token response
- 8-turn history maintained client-side
- Model instructed to flag uncertainty, never diagnose or prescribe
- Restricted to pharmacology and medicine-related questions

### 4.7 Server Status
- Header pill shows backend and model status on load
- Amber (checking) → green (connected) → red (offline)
- On mobile (≤400px), collapses to dot only — label hidden

### 4.8 Mobile Responsiveness
The interface is fully responsive across three breakpoints:

| Breakpoint | Key changes |
|---|---|
| ≤768px (tablet / large phone) | Tighter padding, smaller type, single-column manufacturer grid, special population items wrap to two lines, chat height reduced, chatbot sub-label hidden |
| ≤400px (small phone) | Server pill collapses to dot, drug title stacks vertically, further type reduction |
| Touch devices (hover: none) | All interactive elements enforced to minimum 44px tap target |

This is a prerequisite for the doctor-in-consultation use case — doctors in India look things up on phones during appointments.

---

## 5. Non-Goals (v1)

- Full clinician mode (PK/PD, CYP450, monitoring parameters, guideline references) — future consideration
- Shareable patient summary / doctor's note field — near-term roadmap item
- Multi-drug interaction checking
- Language support beyond English
- Prescription upload or OCR
- User accounts or saved medication lists
- Real-time pricing from live databases

---

## 6. Data Model

```
DrugProfile {
  name, genericName, brandName
  drugClass, category
  plainEnglishSummary        // ≤4 sentences, non-clinical language
  howItWorks                 // mechanism, plain language
  usedFor[]
  warnings[]
  sideEffects[]              // { name, severity: MAJOR|MODERATE|MINOR, description, frequency }
  interactions[]             // { drug, effect, severity }
  indianManufacturers[]      // { brand, manufacturer, strength, type }
  nppaCeilingPrices[]        // { dosageForm, ceilingPriceRs }
  dosageSimple               // single sentence
  dosageDetails              // flat string: "Label: value. Label: value."
  approvalTimeline[]         // { event, year }
  whoEssential, genericAvailable, pregnancyCategory  // A / B / C / D / X
  controlled, canBuyWithout, fdaApproved
}
```

---

## 7. Typography

| Font | Usage |
|---|---|
| Playfair Display (serif) | Logo, hero heading, drug name, welcome heading, manufacturer brand name, chatbot header |
| DM Sans | Body text, search input, buttons, all prose |
| DM Mono | Labels, badges, status pills, monospace data (prices, dates) |

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Drug lookup success rate | >90% for commonly prescribed Indian drugs |
| Time to result | <5s on Groq (excluding cold start) |
| Hallucination catch rate | Placeholder detection blocks >95% of malformed outputs |
| Chat relevance | Model stays on-topic (pharmacology only) |
| Mobile usability | All interactive elements meet 44px minimum tap target on touch devices |

---

## 9. Known Limitations

- All drug data is LLM-generated — accuracy is bounded by model training data and knowledge cutoff
- Indian pricing is approximate; not sourced from live databases
- NPPA data is from 2022 and updated manually
- No multi-drug interaction checking
- English only — excludes a large share of potential Indian users
- Free tier Render hosting causes cold start delays (~30s after inactivity)
- MedLens is a communication aid — it must not be used as a sole clinical reference by practitioners

---

## 10. Roadmap

**Near-term — doctor use case enablers**
- Shareable patient summary — a clean, tab-free view the doctor can send to a patient; summary + side effects + price only
- Doctor's note field — optional contextual note the doctor adds before sharing
- NPPA data refresh

**Near-term — stability**
- Fuzzy drug name matching for typo tolerance
- Cold start UX improvement ("waking up the server…" state)

**Medium-term**
- OpenFDA integration as RAG source for grounded drug data
- Multi-drug interaction checker
- Indian languages support
- Prescription photo OCR

**Longer-term**
- Clinician mode (separate schema, clinical terminology, PK/PD, CYP data, guideline references) — only viable after OpenFDA grounding is in place
- Biomedical model evaluation (BioMistral, Meditron)
- User accounts with saved medication lists
- DigiLocker / ABHA integration

---

## 11. Constraints

- Free tier infrastructure (Render) — no persistent storage, cold starts
- Single LLM call per drug search — structured JSON output required
- No PII collected — queries processed by Groq API under their terms
- Medical disclaimer required on all surfaces, including any future shareable views
- MedLens is a communication aid, not a clinical decision support tool — this framing must be preserved in all copy and disclaimers

---