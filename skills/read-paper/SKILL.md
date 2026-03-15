---
name: read-paper
description: "Full research paper reading workflow: acquire PDF, extract text, structural scan, four reading passes, interrogation prompts, and layered deliverables (discussion notes, executive summary, formal critique memo, synthesis note). Use when asked to read, analyze, review, or summarize a research paper."
---

Full structured workflow for reading and analyzing a research paper PDF. Produces layered deliverables from raw technical notes through synthesis.

## Inputs

Collect before starting:
- **Paper URL** or **local PDF path**
- **Title**
- **Venue / year**
- **Output directory** (default: same directory as the PDF)
- **Prefix** (default: derive from PDF filename — use the hash/slug already in the filename if present, e.g. `209423f076b6479ab3a4f45886e30306-Paper-Conference`)

---

## Step 1 — Acquire and normalize

1. If a URL is given, download the PDF:
   ```bash
   curl -L "<url>" -o "<prefix>.pdf"
   ```
2. Verify the file exists and size is non-trivial (`ls -lh <prefix>.pdf`).
3. Confirm the prefix follows the naming convention:
   - `<hash-or-slug>-Paper-Conference.pdf`
   - Example: `209423f076b6479ab3a4f45886e30306-Paper-Conference.pdf`

---

## Step 2 — Extract machine-readable text

Choose extractor based on content:

**Math-heavy papers** (equations, multi-column, tables): use `pdf-extract` skill:
```bash
cd ~/.agent-stuff/skills/pdf-extract
node extract.mjs <prefix>.pdf --output <outdir>/<title>-main-text-clean.md
```

**Prose-only papers**: use `summarize` skill:
```bash
cd ~/.agent-stuff/skills/summarize
uvx --from 'markitdown[pdf]' markitdown <prefix>.pdf > <outdir>/<title>-main-text-clean.md
```

Also produce a plain-text copy:
```bash
cp <outdir>/<title>-main-text-clean.md <outdir>/<title>-main-text-clean.txt
```

Expected output files:
- `<title>-main-text.txt` (raw extraction if available)
- `<title>-main-text-clean.txt`
- `<title>-main-text-clean.md`

---

## Step 3 — Structural scan (5–10 min)

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

1. **`<prefix>-discussion-notes.md`** — raw technical notes from all four passes + interrogation answers
2. **`<prefix>-executive-summary.md`** — one page; accessible to a lab member unfamiliar with the paper
3. **`<prefix>-formal-critique-memo.md`** — detailed critique; use the `critique` skill for structure if helpful
4. **`<prefix>-synthesis-note.md`** — final position, relation to existing work, extension ideas

Optional:
5. **`<prefix>_vs_<other>_comparison.md`** — cross-paper comparison if relevant

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
## A. Acquisition
- [x] PDF downloaded
- [x] File opens and size looks correct
- [x] Stable local naming applied

## B. Text processing
- [x] Raw extraction generated (<title>-main-text.txt)
- [x] Clean text generated (<title>-main-text-clean.txt)
- [x] Clean markdown generated (<title>-main-text-clean.md)

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
| `<hash>-Paper-Conference.pdf` | Original PDF |
| `<title>-main-text.txt` | Raw extracted text |
| `<title>-main-text-clean.txt` | Cleaned plain text |
| `<title>-main-text-clean.md` | Cleaned markdown |
| `<hash>-discussion-notes.md` | Pass A–D notes + interrogation |
| `<hash>-executive-summary.md` | One-page summary |
| `<hash>-formal-critique-memo.md` | Detailed critique |
| `<hash>-synthesis-note.md` | Final position + extensions |

Use the MD5 hash of the PDF filename if available (as in NeurIPS/ICLR proceedings URLs). Otherwise use a short slug.

---

## Notes

- Do not skip passes or merge them — the layered structure is intentional.
- Separate **paper claims** from **your analysis** throughout.
- If extracted text quality is poor (garbled equations, missing sections), state confidence explicitly and re-extract with the other tool.
- For the formal critique memo, the `critique` skill's prompt format (C1, C2, … with type/severity/quoted passage) is a good match.
