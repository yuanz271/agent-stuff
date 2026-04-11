# Agent Stuff

This repository contains skills and extensions that I use in some form with projects. Note that I usually fine-tune these for projects, so they might not work without modification for you.

Its package metadata uses the name `agent-stuff` for use with the [Pi](https://buildwithpi.ai/) package loader.

## Agent policy files

`AGENTS_global.md` is deprecated in this repo and now points to the canonical `AGENTS.md` via symlink for backward compatibility.

## Skills

All skill files are in the [`skills`](skills) folder:

* [`/commit`](skills/commit) - Git commits using concise Conventional Commits-style subjects
* [`/update-changelog`](skills/update-changelog) - Updating changelogs with notable user-facing changes
* [`/github`](skills/github) - Interacting with GitHub via the `gh` CLI (issues, PRs, runs, and APIs)
* [`/librarian`](skills/librarian) - Caching and refreshing remote git repositories in `~/.cache/checkouts`
* [`/mermaid`](skills/mermaid) - Creating and validating Mermaid diagrams with the official Mermaid CLI
* [`/critique`](skills/critique) - Structured critique of writing or code with numbered critiques (C1, C2, ...), severity, quoted passages, and inline {C1} markers in an annotated copy
* [`/simplify`](skills/simplify) - Portable prompt-only guidance for simplifying recently changed code while preserving behavior
* [`/pdf-extract`](skills/pdf-extract) - High-fidelity PDF → Markdown via Vertex AI Gemini (equations, tables, multi-column layout)
* [`/read-paper`](skills/read-paper) - Full research paper reading workflow: acquire, extract, structural scan, four reading passes, interrogation prompts, and layered deliverables
* [`/summarize`](skills/summarize) - Converting URLs/files to Markdown with optional summaries, including structured research-paper critique mode for PDF papers
* [`/tmux`](skills/tmux) - Driving tmux directly with keystrokes and pane output scraping
* [`/uv`](skills/uv) - Using `uv` for Python dependency management and script execution
* [`/make-release`](skills/make-release) - Bump version, update changelog, commit, tag, and show push instructions
* [`/liteparse`](skills/liteparse) - Parse PDF, DOCX, PPTX, XLSX, and images locally with LiteParse (no cloud dependencies)

## PI Coding Agent Extensions

Custom extensions for the PI Coding Agent can be found in the [`pi-extensions`](pi-extensions) folder:

* [`control.ts`](pi-extensions/control.ts) - Session control helpers (list controllable sessions etc.).
* [`lead-worker`](pi-extensions/lead-worker) - Lead-worker mode controller for a persistent tmux-backed worker session scoped to the current lead session. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/lead` toggles mode on/off; `off` exits lead mode without touching the worker; `stop` stops the paired worker and also exits lead-worker mode if it is on; `/build` delegates the latest lead context to the worker; and lead↔worker direct messages use an internal session-scoped mailbox via `lead_worker({ action: "message", ... })`. Settings are layered as bundled defaults → global `~/.pi/agent/lead-worker-settings.yaml` → project `.pi/lead-worker-settings.yaml`.
* [`prompt-editor.ts`](pi-extensions/prompt-editor.ts) - In-editor prompt mode selector (default/fast/precise) with per-mode model & thinking persistence, global/project config, prompt history, and shortcuts (Ctrl+Shift+M, Ctrl+Space).
* [`files.ts`](pi-extensions/files.ts) - Unified file browser that merges git status (dirty first) with session references, plus reveal/open/edit and diff actions.
* [`init.ts`](pi-extensions/init.ts) - Pi-specific `/init` bootstrap command that embeds its contributor-guide prompt and asks pi to generate the current repo's `AGENTS.md`.
* [`loop.ts`](pi-extensions/loop.ts) - Runs a prompt loop for rapid iterative coding with optional auto-continue control.
* [`review.ts`](pi-extensions/review.ts) - Code review command inspired by Codex. Supports reviewing uncommitted changes, against a base branch (PR style), specific commits, or with custom instructions, plus optional loop fixing mode that iterates review→fix until blocking findings are cleared. Includes Ctrl+R shortcut.
* [`websearch`](pi-extensions/websearch) - Vertex AI Gemini grounded web search tool (`websearch`) that returns a concise summary and source URLs from grounding metadata. Defaults to `gemini-2.5-flash`; `gemini-3-flash-preview` is a currently validated experimental override on the global endpoint.
* [`pi-schedule-prompt`](pi-extensions/pi-schedule-prompt) - Schedule one-shot or recurring future prompts with `schedule_prompt` and manage them via `/schedule-prompt`.
* [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) - TUI for 7/30/90-day session and cost analysis with usage graph.
* [`side-chat`](pi-extensions/side-chat) - Fork the current conversation into a non-capturing overlay side chat (`Alt+/`, `/side`) while the main agent keeps working.

## Docs

Reference documents in the [`docs`](docs) folder:

* [`pi-extension-writing-guide.md`](docs/pi-extension-writing-guide.md) - Guide to writing pi-coding-agent extensions

## Intercepted Commands

Command wrappers live in [`intercepted-commands`](intercepted-commands):

* [`pip`](intercepted-commands/pip)
* [`pip3`](intercepted-commands/pip3)
* [`poetry`](intercepted-commands/poetry)
* [`python`](intercepted-commands/python)
* [`python3`](intercepted-commands/python3)
