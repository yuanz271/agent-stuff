---
name: paper-reader
description: Read and analyze academic papers from PDF with a reliable extraction pipeline (text extraction first, OCR fallback), then produce structured scientific summaries and critique.
---

# Paper Reader Skill

Use this skill when the user asks to read, summarize, compare, critique, or extract evidence from an academic paper PDF.

## Trigger cues

- "read this paper/pdf"
- "summarize this paper"
- "extract methods/results/limitations"
- "pull tables/metrics from paper"
- "compare two papers"
- "this PDF is scanned / OCR this paper"

## Goals

1. Extract reliable content from PDF (text-first; OCR only when needed).
2. Produce a structured, evidence-grounded summary.
3. Separate **paper claims** from **your critique**.
4. Preserve uncertainty: mark missing/ambiguous sections explicitly.

## Workflow

### 1) Ingestion and quality gate

- Confirm input path(s) and count pages.
- Try text extraction first.
- If extraction is empty/garbled, switch to OCR fallback.
- Report extraction path used:
  - `text-extraction`
  - `ocr-fallback`

### 2) Section extraction

Extract (if present):

- Abstract
- Introduction
- Related Work
- Method
- Experimental Setup
- Results
- Ablations
- Limitations
- Conclusion

If missing, output `Not found`.

### 3) Evidence extraction

- Extract quantitative results into structured tuples:
  - dataset
  - metric
  - value
  - baseline/comparator (if available)
  - page reference (if available)
- Extract key assumptions and stated failure modes.
- Extract reproducibility signals: code/data availability, seed/hyperparameter details.

### 4) Scientific synthesis

Produce:

- 1–2 sentence thesis
- 3–5 key contributions
- method mechanism summary
- experiment protocol summary
- top quantitative findings
- limitations and threats to validity
- open questions for follow-up

### 5) Critical appraisal

Explicitly separate:

- **What the paper claims**
- **What evidence supports it**
- **What remains weak or untested**

Do not present unsupported inferences as facts.

## Preferred extraction commands

Use lightweight, reproducible commands.

### Option A: markitdown (fast first pass)

```bash
uvx markitdown "paper.pdf" > /tmp/paper.md
```

### Option B: python text extraction

```bash
uv run --with pdfplumber python3 - <<'PY'
import pdfplumber
with pdfplumber.open('paper.pdf') as pdf:
    for i, page in enumerate(pdf.pages, 1):
        text = page.extract_text() or ""
        print(f"\n\n## Page {i}\n")
        print(text)
PY
```

### OCR fallback for scanned PDFs

```bash
uv run --with pytesseract,pdf2image python3 - <<'PY'
import pytesseract
from pdf2image import convert_from_path
images = convert_from_path('paper.pdf')
for i, img in enumerate(images, 1):
    print(f"\n\n## OCR Page {i}\n")
    print(pytesseract.image_to_string(img))
PY
```

## Output template

Use this exact structure unless the user requests otherwise:

```md
## Extraction Path

## Paper at a Glance
- Problem:
- Core idea:
- Main claim:

## Method

## Experiments & Results

## Limitations

## Critical Appraisal
- Strongly supported:
- Weakly supported:
- Missing evidence:

## Reproducibility Notes

## Open Questions
```

## Guardrails

- Quote or paraphrase only from extracted content; avoid hallucinated details.
- Keep equations/notation faithful; if unreadable, say so.
- For comparisons across papers, normalize metrics and dataset names before concluding.
- If extraction quality is low, state confidence as `low` and suggest a re-run strategy.
