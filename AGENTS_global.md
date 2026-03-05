# Global Agent Rules

These rules express my default preferences across projects. If a repo has its own rules, follow the repo rules where they are stricter or more specific.

## Git (Local + Remote)

- Do not run any remote/upstream-affecting or history-rewriting git operations without explicit permission.
  - Examples: `git push`, `git pull`, `git merge`, `git rebase`, `git tag`, deleting remote branches, any force operation.
- Commits: local commits are pre-approved by default for the active task unless the user says otherwise.
  - If the user says "no commits" (or similar), do not commit without explicit permission.
  - If pre-approved, commit at logical milestones without interrupting active implementation.
  - Do not auto-commit purely exploratory or debug-only changes unless explicitly requested.
  - Before committing, provide a brief scope summary (`git status` + diff summary) so the user can correct scope if needed.
- Before each commit, run `git status` and `git diff` (or `git diff --stat` + focused diffs) to confirm scope and show what will be committed.
- If staged/changed files include unrelated work, ask for confirmation before committing.
- Run sensitive git operations in isolation (no chained commands). In particular, never combine `commit`/`push` with other commands in a single shell invocation.

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
