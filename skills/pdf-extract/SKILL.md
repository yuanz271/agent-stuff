---
name: pdf-extract
description: "High-fidelity PDF → Markdown conversion via Vertex AI Gemini. Preserves equations (LaTeX), tables, multi-column layout, and figure captions. Use this instead of markitdown when the PDF has heavy math or complex structure."
---

Convert a PDF to well-structured Markdown using Vertex AI Gemini (`gemini-2.5-flash` default; override with `--model`).
Accepts a local file path or a GCS URI (`gs://`).

Prefer this skill over `summarize`/`markitdown` when:
- The PDF contains LaTeX equations (`$...$`, `$$...$$`)
- Multi-column layout is present (papers, journals)
- Tables, figure captions, or footnotes need faithful preservation
- You need the full document text, not a summary

Use `summarize`/`markitdown` for quick prose-only PDFs or when Vertex AI is unavailable.

## Usage

Paths are relative to this skill directory.

> **Timeout:** PDF extraction is slow — use a bash timeout of at least 120 seconds. Large PDFs (>5 MB) may need 180–300 seconds.

```bash
# Print extracted Markdown to stdout
node extract.mjs <path-to-pdf>

# Write extracted Markdown to a file
node extract.mjs paper.pdf --output paper-clean.md

# Use a GCS URI instead of a local file
node extract.mjs gs://my-bucket/paper.pdf --output paper-clean.md

# Use a different model
node extract.mjs paper.pdf --model gemini-2.5-pro
node extract.mjs paper.pdf --model gemini-2.5-flash
```

## Output

The model outputs only the converted document — no preamble or commentary.
Formatting rules applied:
- `#` / `##` / `###` for section headings
- Bold and italic preserved
- Equations as `$inline$` and `$$display$$`
- Tables as Markdown tables
- Figure captions and footnotes preserved
- Page numbers, running headers, footers, and line numbers omitted

## Notes

- Model: `gemini-2.5-flash` default; override with `--model <id>` (e.g. `gemini-2.5-pro`, `gemini-3.1-flash-lite-preview`).
- Local files are base64-encoded inline; use a GCS URI for PDFs over ~10 MB.
