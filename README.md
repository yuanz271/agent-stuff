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

## PI Coding Agent Extensions

Custom extensions for the PI Coding Agent can be found in the [`pi-extensions`](pi-extensions) folder:

* [`answer.ts`](pi-extensions/answer.ts) - Interactive TUI for answering questions one by one.
* [`control.ts`](pi-extensions/control.ts) - Session control helpers (list controllable sessions etc.).
* [`damage-control`](pi-extensions/damage-control) - Default-on safety guardrails for tool calls with layered policy rules, runtime panel (`/damage-control`, `/dc`), and policy event logging.
* [`plan-mode`](pi-extensions/plan-mode) - Read-only planning/execution mode with restricted tools, plan extraction, and progress tracking.
* [`prompt-editor.ts`](pi-extensions/prompt-editor.ts) - In-editor prompt mode selector (default/fast/precise) with per-mode model & thinking persistence, global/project config, prompt history, and shortcuts (Ctrl+Shift+M, Ctrl+Space).
* [`files.ts`](pi-extensions/files.ts) - Unified file browser that merges git status (dirty first) with session references, plus reveal/open/edit and diff actions.
* [`init.ts`](pi-extensions/init.ts) - Pi-specific `/init` bootstrap command that embeds its contributor-guide prompt and asks pi to generate the current repo's `AGENTS.md`.
* [`loop.ts`](pi-extensions/loop.ts) - Runs a prompt loop for rapid iterative coding with optional auto-continue control.
* [`lsp.ts`](pi-extensions/lsp.ts) - Lazy auto-start background LSP integration for agent coding loops: prefers project-local LSP binaries (`node_modules/.bin`, `.venv/bin`) before global PATH, injects concise diagnostics after `write`/`edit`, and provides lightweight debug commands (`/lsp-status`, `/lsp-reload`).
* [`review.ts`](pi-extensions/review.ts) - Code review command inspired by Codex. Supports reviewing uncommitted changes, against a base branch (PR style), specific commits, or with custom instructions, plus optional loop fixing mode that iterates review→fix until blocking findings are cleared. Includes Ctrl+R shortcut.
* [`websearch`](pi-extensions/websearch) - Vertex AI Gemini grounded web search tool (`websearch`) that returns a concise summary and source URLs from grounding metadata. Defaults to `gemini-2.5-flash`; `gemini-3-flash-preview` is a currently validated experimental override on the global endpoint.
* [`session-stats`](pi-extensions/session-stats) - In-session observability panel: per-tool call counts, file timeline, turns, loops, model history. `/session-stats` command or `Ctrl+Alt+T`.
* [`pi-tasks`](pi-extensions/pi-tasks) - Claude Code-style task tracking extension with task tools, widget, dependency graph, and optional subagent task execution (`/tasks` command).
* [`pi-subagents`](pi-extensions/pi-subagents) - Claude Code-style autonomous sub-agent orchestration with `Agent`, `get_subagent_result`, and `steer_subagent` tools plus `/agents` UI.
* [`pi-supervisor`](pi-extensions/pi-supervisor) - Outcome-focused supervisory overlay that monitors runs and injects steering via `/supervise`.
* [`pi-schedule-prompt`](pi-extensions/pi-schedule-prompt) - Schedule one-shot or recurring future prompts with `schedule_prompt` and manage them via `/schedule-prompt`.
* [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) - TUI for 7/30/90-day session and cost analysis with usage graph.
* [`side-chat`](pi-extensions/side-chat) - Fork the current conversation into a non-capturing overlay side chat (`Alt+/`, `/side`) while the main agent keeps working.
* [`uv.ts`](pi-extensions/uv.ts) - Bash wrapper that routes Python tooling (`pip`, `poetry`, `python -m ...`) toward `uv` workflows via intercepted commands.

## Docs

Reference documents in the [`docs`](docs) folder:

* [`pi-extension-writing-guide.md`](docs/pi-extension-writing-guide.md) - Guide to writing pi-coding-agent extensions

## Plumbing Commands

These command files need customization before use. They live in [`plumbing-commands`](plumbing-commands):

* [`/make-release`](plumbing-commands/make-release.md) - Automates repository release with version management.

## Intercepted Commands

Command wrappers live in [`intercepted-commands`](intercepted-commands):

* [`pip`](intercepted-commands/pip)
* [`pip3`](intercepted-commands/pip3)
* [`poetry`](intercepted-commands/poetry)
* [`python`](intercepted-commands/python)
* [`python3`](intercepted-commands/python3)
