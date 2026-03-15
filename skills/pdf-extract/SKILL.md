---
name: pdf-extract
description: "High-fidelity PDF → Markdown conversion via Vertex AI Gemini. Preserves equations (LaTeX), tables, multi-column layout, and figure captions. Use this instead of markitdown when the PDF has heavy math or complex structure."
---

Convert a PDF to well-structured Markdown using Vertex AI Gemini (`gemini-2.5-flash`).
Accepts a local file path or a GCS URI (`gs://`).

Prefer this skill over `summarize`/`markitdown` when:
- The PDF contains LaTeX equations (`$...$`, `$$...$$`)
- Multi-column layout is present (papers, journals)
- Tables, figure captions, or footnotes need faithful preservation
- You need the full document text, not a summary

Use `summarize`/`markitdown` for quick prose-only PDFs or when Vertex AI is unavailable.

## Prerequisites

1. `GOOGLE_CLOUD_PROJECT` environment variable set to your GCP project ID.
2. Vertex AI authenticated: `gcloud auth application-default login`
3. `GOOGLE_CLOUD_LOCATION` (optional, defaults to `us-central1`)

## First-time setup

Install dependencies (once per machine):

```bash
npm install
```

## Usage

Paths are relative to this skill directory.

```bash
# Print extracted Markdown to stdout
node extract.mjs <path-to-pdf>

# Write extracted Markdown to a file
node extract.mjs paper.pdf --output paper-clean.md

# Use a GCS URI instead of a local file
node extract.mjs gs://my-bucket/paper.pdf --output paper-clean.md
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

- Local files are base64-encoded and sent inline. Large PDFs (>10 MB) may be slow or hit limits — use a GCS URI instead.
- Model: `gemini-2.5-flash` (hardcoded in `extract.mjs`; edit to change).
- Region: `GOOGLE_CLOUD_LOCATION` env var (default: `us-central1`).
