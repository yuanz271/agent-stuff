---
name: critique
description: "Structured critique of writing or code. Produces numbered critiques (C1, C2, ...) with type, severity, exact quoted passage, and an annotated copy of the source with {C1} markers. Use when asked to critique, review, or give structured feedback on a file or the last response."
---

Produce a structured critique of the provided content.

## Input

The content to critique is either:
- The last assistant response (if no file is specified)
- A file passed via `@path` or explicit path argument
- Content the user pastes directly

## Lens detection

Auto-detect whether content is **code** or **writing** based on file extension or content, unless the user specifies:

- **Code**: `.ts`, `.tsx`, `.js`, `.py`, `.rs`, `.go`, `.java`, `.kt`, `.c`, `.cpp`, `.cs`, `.rb`, `.sh`, `.sql`, `.html`, `.css`, `.json`, `.yaml`, `.toml`, `.vue`, `.svelte`, `Dockerfile`, `Makefile`, and similar
- **Writing**: `.md`, `.txt`, `.tex`, `.rst`, `.org`, and similar prose/document formats
- **Override**: if the user says `--code` or `--writing`, use that lens regardless

## Output format

Return your response in this exact structure:

---

## Assessment

1–2 paragraph overview of strengths and key areas for improvement.

## Critiques

**C1** (type, severity): *"exact quoted passage"* (writing) or `` `exact code snippet` `` (code)
Your comment. Suggested improvement or fix if applicable.

**C2** (type, severity): *"exact quoted passage"*
Your comment.

(continue as needed)

## Document (or Code)

Reproduce the complete original content with `{C1}`, `{C2}`, etc. markers placed immediately after each critiqued passage or line. Preserve all original formatting exactly.

---

## Critique types

Do not use a fixed list — choose types that fit the content:

**Writing** (examples): `overstatement`, `evidence`, `wordiness`, `credibility`, `factcheck`, `pacing`, `voice`, `clarity`, `logic`, `scope`, `jargon`, `citation`, `ambiguity`

**Code** (examples): `bug`, `performance`, `readability`, `architecture`, `security`, `naming`, `error-handling`, `duplication`, `coupling`, `testability`, `suggestion`

## Severity

Use `high`, `medium`, or `low`. List higher severity critiques first.

## Rules

- 3–8 critiques, only where genuinely useful — do not pad
- Quoted passages must be exact verbatim text from the source
- Be intellectually rigorous but constructive
- Suggest concrete fixes where possible
- Do not edit or modify the source file — output only (the annotated copy is in your response, not written to disk unless explicitly asked)
- Place `{C1}` markers immediately after the relevant passage in the Document/Code section

## Reply loop

After the critique, the user may respond with bracketed annotations. Honour them in the next revision:

- `[accept C1]` — acknowledged, incorporate the fix
- `[reject C2: reason]` — noted, do not apply
- `[revise C3: guidance]` — revise with their guidance
- `[question C4]` — explain the critique further

## Skipping the annotated copy

If the user says `--no-inline`, omit the Document/Code section and return Assessment + Critiques only (saves tokens for large content).

## Large content

For content over ~500 lines passed as a file path: read the file with your tools, produce the critique, and if asked to write an annotated copy write it to `<filename>.critique.<ext>` — do not overwrite the original.
