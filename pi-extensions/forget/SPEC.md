# Forget Extension Spec
*Safe session cleanup by branching away from stale context.*

## Purpose
The `forget` extension provides a safe way to remove stale, conflicting, or irrelevant context from future turns without rewriting session files in place.

The core idea is not transcript surgery in the main working context. It is safe branch replacement:
- inspect the current session tree
- use a transient sanitizer session to produce a cleaned context artifact
- fork a new branch seeded from that cleaned artifact
- continue in the new branch
- leave the old branch intact

The new branch must not contain any visible `/forget` trace or tombstone message.
The main agent should not be told that forgetting occurred.

## Goals
- Remove stale instructions from future context.
- Avoid prompt-visible “forgotten” markers, tombstones, or tag clutter.
- Support fuzzy forgetting over scattered, multi-turn context.
- Stay within supported Pi session operations.
- Keep sanitation work out of the main working session.
- Never mutate session JSONL files directly.

## Non-goals
- No in-place deletion of arbitrary session entries.
- No direct rewriting of session JSONL files.
- No `/remember` command.
- No hidden meta-explanation injected into the new branch.
- No best-effort heuristics that silently rewrite history.

## User-facing command
### `/forget <query>`
A fuzzy cleanup command that removes stale semantic content from the active future branch by producing a clean successor context.

Behavior:
1. Parse the fuzzy query.
2. Search the current session tree and branch history for candidate stale semantic content.
3. Launch a transient sanitizer session/context with only the minimal session-tree data needed to produce a cleaned context artifact.
4. Ask the sanitizer to remove stale instructions, rules, facts, summaries, and related derived context.
5. If the sanitizer can produce a single clean successor context, use it.
6. If the sanitizer reports ambiguity, surface the candidates so the user can choose.
7. Create the new branch using Pi’s session branching API.
8. Seed the new branch from the sanitizer’s cleaned context artifact.
9. Do not emit any `/forget` text into the new branch.

## Safety policy
The extension must be conservative.

It may:
- read session history
- inspect the session tree
- call Pi’s branching/navigation APIs
- launch a transient sanitizer session/context
- use a different model for the sanitizer than the main session
- ask the sanitizer to emit a cleaned context artifact
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
3. The extension maps the fuzzy request to one or more candidate semantic regions in the session tree.
4. The extension offers the likely clean successor context(s).
5. The user confirms one if needed.
6. The extension forks into the cleaned branch.
7. The new branch becomes the active continuation.

## Design constraints
- The old branch remains available for audit/history.
- The new branch should look like an ordinary continuation.
- No tombstones, tags, or “forgotten” markers should be introduced into model-visible context.
- Sanitization must run in a separate transient session/context, not inside the contaminated working session.
- The sanitizer is one-shot and non-persistent.
- The sanitizer should emit a cleaned context artifact that seeds the new branch.
- If the cleanup requires a summary for navigation, keep it outside the LLM-visible continuation branch.

## Implementation sketch
- Use session tree inspection for candidate discovery.
- Use `ctx.navigateTree(...)` when the user needs to choose among branches or to move to a specific point in the tree.
- Use `ctx.fork(...)` to create the cleaned continuation branch.
- Reconstruct any extension-local state from the active branch after the fork.
- Treat the forked branch as the only future context source.

## Prompt templates

### Main orchestration prompt
```text
You are coordinating a transient sanitizer session for a Pi `/forget` operation.

Task:
- Given the provided session-tree excerpt and fuzzy user query, determine the safest semantic redaction needed to produce a clean successor context.
- The sanitizer session is isolated, one-shot, and non-persistent.
- Do not modify the main session.
- Do not write files.
- Do not mention or surface the existence of `/forget` to the model-visible continuation branch.

Input:
- fuzzy query
- compact session tree / branch excerpt
- any candidate semantic groups already identified

Output:
- Return only machine-readable JSON matching the requested schema.
- If there is one clear cleaned context, choose it.
- If there are multiple plausible clean contexts, return the minimal candidate set.
- If no safe cleanup exists, return blocked.

Constraints:
- Prefer the smallest clean successor context that preserves useful recent work.
- Be conservative; fail closed on ambiguity.
- Do not include chain-of-thought or hidden reasoning.
```

### Sanitizer prompt
```text
You are a transient sanitizer session for a Pi `/forget` workflow.

Goal:
- Inspect only the provided session-tree/context excerpt.
- Produce a cleaned context artifact that removes stale instructions, rules, facts, summaries, and related derived context.
- Prefer the smallest clean successor context that preserves useful recent work.

Rules:
- Do not modify the main session.
- Do not write files.
- Do not persist state.
- Do not mention `/forget` unless asked for output format.
- Do not explain chain-of-thought.
- If the cleanup is ambiguous, return the minimal set of candidate clean contexts with brief labels.
- If no safe cleanup exists, say so explicitly.

Output format:
- Return only machine-readable JSON.
- Schema:
  {
    "status": "ok" | "ambiguous" | "blocked",
    "cleanContext": {
      "systemPrompt": string,
      "retainedSummary": string,
      "messages": [
        {
          "role": "user" | "assistant" | "custom",
          "content": string,
          "customType": string | null
        }
      ]
    } | null,
    "removed": [
      {
        "kind": "instruction" | "rule" | "fact" | "summary" | "custom",
        "label": string,
        "reason": string
      }
    ],
    "candidates": [
      {
        "label": string,
        "reason": string
      }
    ],
    "notes": [string]
  }
```

## Failure modes
- Query matches multiple incompatible semantic redactions: ask the user.
- No clean successor context can be produced: do nothing.
- The current session cannot be forked cleanly: fail closed.
- The sanitizer cannot determine a clean semantic redaction set: fail closed.
- The user asks for direct deletion/surgery: refuse and offer branching instead.

## UX principles
- Fuzzy input is acceptable.
- Ambiguity is explicit.
- Cleanup is invisible to the main model.
- The sanitizer context leaves no persistent trace.
- The extension behaves as if the stale context never existed in the new branch.
- The new branch is seeded only from the cleaned context artifact.

## Acceptance criteria
- `/forget` produces a new cleaned branch, not a rewritten transcript.
- The new branch contains no visible `/forget` message.
- The old branch is preserved.
- The agent does not see tombstones or deletion notes in future context.
- The new branch is seeded from sanitizer output, not by mutating the old branch in place.
- No direct JSONL mutation is performed.
