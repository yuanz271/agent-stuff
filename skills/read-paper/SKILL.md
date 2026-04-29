---
name: read-paper
description: "Full research paper reading workflow: acquire PDF, extract text, structural scan, four reading passes, interrogation prompts, raw discussion notes, and one self-contained final report. Use when asked to read, analyze, review, or summarize a research paper."
---

Full structured workflow for reading and analyzing a research paper PDF. Produces raw discussion notes plus one self-contained final report.

## Inputs

Collect before starting:
- **Local PDF path** — all artifacts are written to the same directory as the PDF, named after the PDF filename stem
- **Title**
- **Venue / year** (e.g. NeurIPS 2024, arXiv 2023, Nature Neuroscience 2022, bioRxiv 2025)

The **stem** is the PDF filename without extension (e.g. `vaswani2017-transformer` from `vaswani2017-transformer.pdf`). All output files use this stem as their prefix.

---

## Step 1 — Extract machine-readable text

Load and follow the `pdf-extract` skill to extract the PDF. Pass:
- **input**: `<pdf-path>`
- **output**: `<pdf-dir>/<stem>-paper.md`

Expected output file:
- `<pdf-dir>/<stem>-paper.md`

---

## Step 2 — Structural scan

Read the extracted text. Map and report:

- Section headings and hierarchy
- Core equations and method definitions (number and label them)
- Datasets used
- Evaluation metrics
- Baselines compared against

When you record equations, render them as display LaTeX blocks, not plain text, Markdown tables, or pipe-delimited ASCII approximations.

Report findings before proceeding to Step 3.

---

## Step 3 — Four reading passes

Work through each pass in order. Answer every question explicitly.

### Pass A — Framing
- What problem is being solved?
- What is the novel claim?
- What are the explicit assumptions stated by the authors?

### Pass B — Method
- What is the model form? (write the key equation)
- What is the training / inference algorithm?
- What is **optimized** vs **inferred**?
- What parameters are **shared** vs **instance-specific**?

### Pass C — Evidence
- What benchmarks and baselines are used?
- What metrics are reported?
- What ablations are run?
- Which claims are actually supported by the results vs asserted?

### Pass D — Limits
- What limitations do the authors state?
- What hidden assumptions are likely to fail out-of-distribution?
- What are the compute / scalability constraints?

---

## Step 4 — Interrogation prompts

Answer each of these explicitly:

1. Is the method **deterministic or probabilistic** in practice?
2. Where does performance likely come from — architecture, objective, data assumptions, or evaluation setup?
3. Is transfer **zero-shot, few-shot, or full retraining**?
4. Are any interpretability claims **identifiable** or are they coordinate-dependent?
5. What would likely **break first** when applying this to a new domain?

---

## Step 5 — Deliverables

Produce these files in order. The final report must be self-contained; nobody should need to read the intermediate notes to understand the conclusion.

All files are written to the same directory as the PDF (`<pdf-dir>`):

1. **`<stem>-discussion-notes.md`** — raw working notes from all four passes + interrogation answers; this is the only intermediate artifact
2. **`<stem>-paper-report.md`** — the single final, self-contained report that replaces the separate executive summary / formal critique memo / synthesis note

Optional:
3. **`<slug>-comparison.md`** — cross-paper comparison if relevant (two or more papers)

---

## Step 6 — Required format for the final report

The final report should be concise but complete. Include these sections once, in this order:

- **Title + metadata** — paper title, venue/year, one-line verdict
- **Executive summary** — 4–6 bullets covering the problem, method, why it matters, and main result
- **Technical method** — the key equation(s) rendered as display LaTeX blocks, model/algorithm description, what is optimized vs inferred, shared vs instance-specific parameters
- **Evidence and results** — datasets, metrics, baselines, key results, and what is actually supported vs overclaimed
- **Critique / limitations** — main weaknesses, assumptions, OOD risks, identifiability/confounds if relevant
- **Synthesis / relation to prior work** — novelty, relation to existing work, and where it fits in the literature
- **Next experiments** — 3–5 concrete follow-ups, prioritized by value
- **Final recommendation** — keep as reference / candidate for implementation / requires more validation / not suitable, with a short reason

The discussion notes do not need this structure; they are allowed to be messy and comprehensive. Even there, equations should still be rendered as display LaTeX blocks so they remain copyable and viewer-friendly.

---

## Step 7 — Checklist

After deliverables, emit a completed checklist:

```
## A. Text processing
- [x] Clean markdown generated (<stem>-paper.md)

## B. Structural scan
- [x] Section headings mapped
- [x] Core equations identified
- [x] Datasets and metrics listed
- [x] Baselines listed

## C. Method understanding
- [x] What is optimized is clear
- [x] What is inferred is clear
- [x] Shared vs instance-specific parameters identified
- [x] Assumptions explicitly enumerated

## D. Evidence quality
- [x] Ablations checked
- [x] Comparisons are fair (same budget/settings where possible)
- [x] Metrics match claims
- [x] Limitations section reviewed

## E. Critical questions answered
- [x] Deterministic vs probabilistic status clarified
- [x] Zero-shot vs few-shot vs retrain clarified
- [x] Likely source of gains identified
- [x] Failure modes/OOD risks noted

## F. Deliverables completed
- [x] Discussion notes
- [x] Final report
- [ ] Cross-paper comparison (if relevant)

## G. Final recommendation
- [ ] Keep as reference
- [ ] Candidate for implementation
- [ ] Requires additional validation
- [ ] Not suitable for current use case

## Quick decision log
- Decision:
- Reason:
- Next action:
```

Fill in `[ ]`/`[x]` accurately. Fill in the decision log.

---

## Naming convention

All files co-located with the PDF in `<pdf-dir>`, named after the PDF filename stem (`<stem>`):

| File | Purpose |
|---|---|
| `<stem>-paper.md` | Extracted markdown |
| `<stem>-discussion-notes.md` | Pass A–D notes + interrogation |
| `<stem>-paper-report.md` | Single self-contained final report |

---

## Notes

- Do not skip passes or merge them — the layered structure is intentional.
- Separate **paper claims** from **your analysis** throughout.
- If extracted text quality is poor (garbled equations, missing sections), state confidence explicitly and re-invoke the `pdf-extract` skill.
- The final report should subsume summary, critique, and synthesis so the intermediate notes are not needed for comprehension.
