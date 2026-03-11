# Agent Stuff

This repository contains skills and extensions that I use in some form with projects. Note that I usually fine-tune these for projects, so they might not work without modification for you.

It is released on npm as `mitsupi` for use with the [Pi](https://buildwithpi.ai/) package loader.

## Skills

All skill files are in the [`skills`](skills) folder:

* [`/commit`](skills/commit) - Git commits using concise Conventional Commits-style subjects
* [`/update-changelog`](skills/update-changelog) - Updating changelogs with notable user-facing changes
* [`/github`](skills/github) - Interacting with GitHub via the `gh` CLI (issues, PRs, runs, and APIs)
* [`/google-workspace`](skills/google-workspace) - Accessing Google Workspace APIs via local helper scripts (Drive, Docs, Calendar, Gmail, etc.)
* [`/librarian`](skills/librarian) - Caching and refreshing remote git repositories in `~/.cache/checkouts`
* [`/mermaid`](skills/mermaid) - Creating and validating Mermaid diagrams with the official Mermaid CLI
* [`/native-web-search`](skills/native-web-search) - Fast internet research with concise summaries and explicit full source URLs
* [`/pdf`](skills/pdf) - PDF processing: text/table extraction, merge/split/rotate, form filling (fillable and non-fillable), OCR, encryption, and PDF creation
* [`/pi-share`](skills/pi-share) - Loading and parsing session transcripts from shittycodingagent.ai
* [`/simplify`](skills/simplify) - Portable prompt-only guidance for simplifying recently changed code while preserving behavior
* [`/summarize`](skills/summarize) - Converting URLs/files to Markdown with optional summaries
* [`/tmux`](skills/tmux) - Driving tmux directly with keystrokes and pane output scraping
* [`/uv`](skills/uv) - Using `uv` for Python dependency management and script execution
* [`/plan`](skills/plan) - Prompt-only plan mode that self-activates on planning intent

## PI Coding Agent Extensions

Custom extensions for the PI Coding Agent can be found in the [`pi-extensions`](pi-extensions) folder. The package also ships an extra extension focused on increasing reliability:

* [`answer.ts`](pi-extensions/answer.ts) - Interactive TUI for answering questions one by one.
* [`btw.ts`](pi-extensions/btw.ts) - Side-conversation extension (`/btw`) for parallel Q&A that can be injected or summarized back into the main session.
* [`context.ts`](pi-extensions/context.ts) - Quick context breakdown (extensions, skills, AGENTS.md/CLAUDE.md) + token usage; highlights skills that were actually read/loaded.
* [`control.ts`](pi-extensions/control.ts) - Session control helpers (list controllable sessions etc.).
* [`delegate.ts`](pi-extensions/delegate.ts) - Thin `/delegate` command that runs a task in an isolated child `pi` process using the current model/tools (supports `--bg`, completion notification, and `/delegate-kill <task-id>` termination).
* [`prompt-editor.ts`](pi-extensions/prompt-editor.ts) - In-editor prompt mode selector (default/fast/precise) with per-mode model & thinking persistence, global/project config, prompt history, and shortcuts (Ctrl+Shift+M, Ctrl+Space).
* [`prompt-template-model.ts`](pi-extensions/prompt-template-model.ts) - Extends prompt templates with `model`/`skill`/`thinking` frontmatter, auto-switching and optional restore, plus `/chain-prompts`.
* [`files.ts`](pi-extensions/files.ts) - Unified file browser that merges git status (dirty first) with session references, plus reveal/open/edit and diff actions.
* [`init.ts`](pi-extensions/init.ts) - Pi-specific `/init` bootstrap command that embeds its contributor-guide prompt and asks pi to generate the current repo's `AGENTS.md`.
* [`loop.ts`](pi-extensions/loop.ts) - Runs a prompt loop for rapid iterative coding with optional auto-continue control.
* [`notify.ts`](pi-extensions/notify.ts) - Sends native desktop notifications when the agent finishes (OSC 777 compatible terminals).
* [`review.ts`](pi-extensions/review.ts) - Code review command inspired by Codex. Supports reviewing uncommitted changes, against a base branch (PR style), specific commits, or with custom instructions, plus optional loop fixing mode that iterates review→fix until blocking findings are cleared. Includes Ctrl+R shortcut.
* [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) - Interactive TUI to analyze the last 7/30/90 days of Pi session usage (sessions + cost by model) with a GitHub-style usage graph.
* [`todos.ts`](pi-extensions/todos.ts) - Todo manager extension with file-backed storage and a TUI for listing and editing todos.
* [`uv.ts`](pi-extensions/uv.ts) - Helpers for working with uv (Python packaging/workflows).

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
