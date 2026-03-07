# Global Agent Rules

These rules express my default preferences across projects. If a repo has its own rules, follow the repo rules where they are stricter or more specific.

Treat permission and side-effect rules as hard constraints. Treat bookkeeping, traceability, and workflow guidance as default practices to apply when useful, without adding unnecessary friction for trivial tasks.

## Permission Model

- A direct user instruction to perform a specific operation counts as explicit permission for that operation.
- If an instruction is ambiguous, conflicts with another rule, or may have broader side effects than the user likely intends, ask for confirmation before acting.

## Git (Local + Remote)

- Routine local git commands are allowed by default when they do not rewrite history, discard changes, or affect remotes.
  - Examples: `git status`, `git diff`, `git log`, `git show`, `git blame`, `git add`, `git branch` (list/create non-destructively), `git switch`, `git checkout` (non-destructive), and `git commit`.
- Do not run remote/upstream-affecting, history-rewriting, history-shaping, or destructive git operations without explicit permission.
  - Examples: `git push`, `git pull`, `git merge`, `git rebase`, `git tag`, `git reset --hard`, `git clean`, deleting remote branches, any force operation.
- Commits: local commits are pre-approved by default for the active task unless the user says otherwise.
  - If the user says "no commits" (or similar), do not commit without explicit permission.
  - If pre-approved, commit at logical milestones without interrupting active implementation.
  - Do not auto-commit purely exploratory or debug-only changes unless explicitly requested.
- If a local git command may discard user work or interfere with unrelated in-progress changes, ask first.
- Before each commit, run `git status` and `git diff` (or `git diff --stat` + focused diffs), and provide a brief scope summary so the user can correct scope if needed.
- If staged/changed files include unrelated work, ask for confirmation before committing.
- Run sensitive git operations in isolation (no chained commands). In particular, never combine `commit`/`push` with other commands in a single shell invocation.

## Task Bookkeeping

- Use a task identifier for each unit of work when available (issue number, TODO id, or short slug).
- For non-trivial or multi-step tasks, keep task state explicit: `todo`, `in_progress`, `blocked`, `done`.
- Record bookkeeping in the repo's existing task system if one exists; otherwise include it in status updates or handoffs rather than creating new files.
- Record blockers and next step in one line each when work pauses or context switches.
- For non-trivial decisions, add a brief decision note (chosen option + reason).
- End each task with a short handoff: what changed, what remains, risks, and next command/action.

## Traceability & Reproducibility

- These are default practices: apply them when useful and proportionate to the task, not as absolute requirements for every trivial change.
- Include a `Generated-by: <agent>` trailer in commit messages for agent-authored work when the project already uses trailers or when attribution would be helpful.
- When useful and non-sensitive, reference the session/conversation that produced a change in the commit body or task note.
- Run relevant validation (tests, lint, type-check, smoke tests) when available and proportionate to the change; if skipped, say why.
- Record the model used for the task when it materially affects reproducibility and doing so is useful and non-sensitive.
- Prefer surgical edits over full file rewrites so diffs stay reviewable and traceable.

## File/Folder Deletion

- Never delete files or folders without explicit permission.
  - Applies to all deletion mechanisms: `rm`, `rmdir`, `unlink`, `git rm`, and tool-based deletions (patch/remove).

## Dependencies & Configuration

- Do not add, remove, or upgrade dependencies without explicit permission.
  - Examples: `npm install`, `pnpm add`, `pip install`, `poetry add`, `cargo add`, `go get`, `bundle add`, updating lockfiles, changing package manager settings.
- Do not modify environment/secret/auth files without explicit permission.
  - Examples: `.env*`, credentials files, key material, auth configs, cloud/provider configs.

## Documentation

- Keep documentation in sync with behavior.
- When code changes affect behavior, API/CLI, configuration, setup, or user-facing output, update the relevant existing docs (README, inline docs, API docs, changelog).
- Do not create new documentation files unless explicitly requested.

## Code Style & Conventions

- Follow existing project structure, naming, and formatting conventions.
- Prefer editing existing files over adding new ones.
- If conventions are unclear, inspect existing code first and match it.

## Safety / Side Effects

- Do not run destructive or irreversible commands without explicit permission.
- Do not run commands that may affect external systems without confirmation.
  - Examples: production/staging deploys, database migrations, writes to cloud resources, paid/billed actions, sending emails/notifications, calling third-party APIs that mutate state.
- If uncertain whether an action has side effects, ask before acting.
