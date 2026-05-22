# Forget Extension Spec
*Safe session cleanup by branching away from stale context.*

## Purpose
The `forget` extension provides a safe way to remove stale, conflicting, or irrelevant context from future turns without rewriting session files in place.

The core idea is not transcript surgery. It is safe branch replacement:
- inspect the current session tree
- identify the point where stale context should stop influencing future turns
- fork a new branch from an earlier safe point
- continue in the new branch
- leave the old branch intact

The new branch must not contain any visible `/forget` trace or tombstone message.
The agent should not be told that forgetting occurred.

## Goals
- Remove stale instructions from future context.
- Avoid prompt-visible “forgotten” markers, tombstones, or tag clutter.
- Support fuzzy forgetting over scattered, multi-turn context.
- Stay within supported Pi session operations.
- Never mutate session JSONL files directly.

## Non-goals
- No in-place deletion of arbitrary session entries.
- No direct rewriting of session JSONL files.
- No `/remember` command.
- No hidden meta-explanation injected into the new branch.
- No best-effort heuristics that silently rewrite history.

## User-facing command
### `/forget <query>`
A fuzzy cleanup command that removes stale context from the active future branch by forking to a safe earlier point.

Behavior:
1. Parse the fuzzy query.
2. Search the current session tree and branch history for candidate stale regions.
3. Determine a safe cutoff point before the unwanted context begins to matter.
4. If there is a unique safe cutoff, fork directly.
5. If multiple cutoffs are plausible, ask the user to choose.
6. Create the new branch using Pi’s session branching API.
7. Continue in the new branch.
8. Do not emit any `/forget` text into the new branch.

## Safety policy
The extension must be conservative.

It may:
- read session history
- inspect the session tree
- call Pi’s branching/navigation APIs
- prompt the user for a choice when ambiguity remains

It must not:
- edit session files directly
- delete arbitrary transcript entries
- hide a cleanup action by injecting a special instruction into the new context
- apply fuzzy deletion without a clear cutoff

If the extension cannot identify a safe cutoff, it should fail closed and explain that the user needs to choose a branch point manually.

## Expected workflow
1. The user notices stale or conflicting instructions in the current context.
2. The user runs `/forget <fuzzy description>`.
3. The extension maps the fuzzy request to one or more candidate regions in the session tree.
4. The extension offers the likely cutoff point(s).
5. The user confirms one.
6. The extension forks to that point.
7. The new branch becomes the active continuation.

## Design constraints
- The old branch remains available for audit/history.
- The new branch should look like an ordinary continuation.
- No tombstones, tags, or “forgotten” markers should be introduced into model-visible context.
- If the cleanup requires a summary for navigation, keep it outside the LLM-visible continuation branch.

## Implementation sketch
- Use session tree inspection for candidate discovery.
- Use `ctx.navigateTree(...)` when the user needs to choose among branches or to move to a specific point in the tree.
- Use `ctx.fork(...)` to create the cleaned continuation branch.
- Reconstruct any extension-local state from the active branch after the fork.
- Treat the forked branch as the only future context source.

## Failure modes
- Query matches multiple incompatible regions: ask the user.
- No safe cutoff can be found: do nothing.
- The current session cannot be forked cleanly: fail closed.
- The user asks for direct deletion/surgery: refuse and offer branching instead.

## UX principles
- Fuzzy input is acceptable.
- Ambiguity is explicit.
- Cleanup is invisible to the model.
- The extension behaves as if the stale context never existed in the new branch.

## Acceptance criteria
- `/forget` produces a new cleaned branch, not a rewritten transcript.
- The new branch contains no visible `/forget` message.
- The old branch is preserved.
- The agent does not see tombstones or deletion notes in future context.
- No direct JSONL mutation is performed.
