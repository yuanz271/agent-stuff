---
name: read-paper
description: "Full research paper reading workflow: acquire PDF, extract text, structural scan, four reading passes, interrogation prompts, and layered deliverables (discussion notes, executive summary, formal critique memo, synthesis note). Use when asked to read, analyze, review, or summarize a research paper."
---

Full structured workflow for reading and analyzing a research paper PDF. Produces layered deliverables from raw technical notes through synthesis.

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

## Step 3 — Structural scan

Read the extracted text. Map and report:

- Section headings and hierarchy
- Core equations and method definitions (number and label them)
- Datasets used
- Evaluation metrics
- Baselines compared against

Report findings before proceeding to Step 4.

---

## Step 4 — Four reading passes

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

## Step 5 — Interrogation prompts

Answer each of these explicitly:

1. Is the method **deterministic or probabilistic** in practice?
2. Where does performance likely come from — architecture, objective, data assumptions, or evaluation setup?
3. Is transfer **zero-shot, few-shot, or full retraining**?
4. Are any interpretability claims **identifiable** or are they coordinate-dependent?
5. What would likely **break first** when applying this to a new domain?

---

## Step 6 — Deliverables

Produce in this order. Each file uses the format in Step 7.

All files written to the same directory as the PDF (`<pdf-dir>`):

1. **`<stem>-discussion-notes.md`** — raw technical notes from all four passes + interrogation answers
2. **`<stem>-executive-summary.md`** — one page; accessible to a lab member unfamiliar with the paper
3. **`<stem>-formal-critique-memo.md`** — detailed critique; use the `critique` skill for structure if helpful
4. **`<stem>-synthesis-note.md`** — final position, relation to existing work, extension ideas

Optional:
5. **`<slug>-comparison.md`** — cross-paper comparison if relevant (two or more papers)

---

## Step 7 — Required format for each deliverable

Every deliverable must include:

- **Take-home** (2–4 bullets)
- **Method in one equation block** (LaTeX)
- **Strengths**
- **Caveats / assumptions**
- **What to test next**

---

## Step 8 — Checklist

After deliverables, emit a completed checklist:

```
## A. Text processing
- [x] Clean markdown generated (<stem>-paper.md)

## C. Structural scan
- [x] Section headings mapped
- [x] Core equations identified
- [x] Datasets and metrics listed
- [x] Baselines listed

## D. Method understanding
- [x] What is optimized is clear
- [x] What is inferred is clear
- [x] Shared vs instance-specific parameters identified
- [x] Assumptions explicitly enumerated

## E. Evidence quality
- [x] Ablations checked
- [x] Comparisons are fair (same budget/settings where possible)
- [x] Metrics match claims
- [x] Limitations section reviewed

## F. Critical questions answered
- [x] Deterministic vs probabilistic status clarified
- [x] Zero-shot vs few-shot vs retrain clarified
- [x] Likely source of gains identified
- [x] Failure modes/OOD risks noted

## G. Deliverables completed
- [x] Discussion notes
- [x] Executive summary
- [x] Formal critique memo
- [x] Synthesis note
- [ ] Cross-paper comparison (if relevant)

## H. Final recommendation
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

| File | Purpose |
|---|---|
All files co-located with the PDF in `<pdf-dir>`, named after the PDF filename stem (`<stem>`):

| File | Purpose |
|---|---|
| `<stem>-paper.md` | Extracted markdown |
| `<stem>-discussion-notes.md` | Pass A–D notes + interrogation |
| `<stem>-executive-summary.md` | One-page summary |
| `<stem>-formal-critique-memo.md` | Detailed critique |
| `<stem>-synthesis-note.md` | Final position + extensions |

---

## Notes

- Do not skip passes or merge them — the layered structure is intentional.
- Separate **paper claims** from **your analysis** throughout.
- If extracted text quality is poor (garbled equations, missing sections), state confidence explicitly and re-invoke the `pdf-extract` skill.
- For the formal critique memo, the `critique` skill's prompt format (C1, C2, … with type/severity/quoted passage) is a good match.
