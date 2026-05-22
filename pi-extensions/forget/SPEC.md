# Forget Extension Spec
*Safe session cleanup by branching away from stale context.*

## Purpose
The `forget` extension provides a safe way to remove stale, conflicting, or irrelevant context from future turns without rewriting session files in place.

The core idea is not transcript surgery in the main working context. It is safe branch replacement:
- inspect the current session tree
- sweep only `SessionEntry.type === "message"` entries whose message role is `user` or `assistant` through a transient sanitizer session one by one
- keep the system prompt and agent-injected content untouched
- deterministically reconstruct a cleaned context artifact in code
- fork a new branch seeded from that reconstructed artifact
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
- Preserve the original context format by construction; the model must only clean `SessionEntry.type === "message"` user/assistant message text and must not author the final `systemPrompt` / `messages` object.

## Non-goals
- No in-place deletion of arbitrary session entries.
- No direct rewriting of session JSONL files.
- No `/remember` command.
- No hidden meta-explanation injected into the new branch.
- No best-effort heuristics that silently rewrite history.

## Implementation plan
1. Sweep user and assistant message text one message at a time.
2. Keep the system prompt and retained summary untouched.
3. Rebuild the cleaned message list deterministically in code after the sweep completes.
4. Smoke-test `/forget` on a stale-session case and verify the reconstructed branch preserves structure except for removed/redacted message text.

## User-facing command
### `/forget <query>`
A fuzzy cleanup command that removes stale semantic content from the active future branch by producing a clean successor context artifact.

Behavior:
1. Parse the fuzzy query.
2. Scan current `SessionEntry.type === "message"` user and assistant message text for stale semantic content.
3. Sweep every `SessionEntry.type === "message"` user/assistant message text field in the current branch.
4. Launch a transient sanitizer session/context with only one eligible message text at a time.
5. Ask the sanitizer to return pure cleaned text for that single message.
6. Deterministically reconstruct the cleaned context in code by replacing or dropping each swept message based on the returned text.
7. Leave the system prompt and agent-injected content untouched.
8. Create the new branch using Pi’s session branching API.
9. Do not emit any `/forget` text into the new branch.

## Safety policy
The extension must be conservative.

It may:
- read session history
- inspect the session tree
- call Pi’s branching/navigation APIs
- launch a transient sanitizer session/context
- use a different model for the sanitizer than the main session
- ask the sanitizer to clean individual `SessionEntry.type === "message"` user/assistant message text fields

It must not:
- edit session files directly
- delete arbitrary transcript entries in place
- ask the model to serialize the final cleaned branch context
- clean the system prompt or agent-injected content through the sanitizer
- hide a cleanup action by injecting a special instruction into the new context
- apply fuzzy deletion without a clear cutoff

If the extension cannot identify a safe cutoff, it should fail closed and explain that the user needs to choose a branch point manually.

## Expected workflow
1. The user notices stale or conflicting instructions in the current context.
2. The user runs `/forget <fuzzy description>`.
3. The extension scans plain user and assistant message text for stale semantic content.
4. The extension cleans each plain message text one by one using the transient sanitizer.
5. The extension forks into the cleaned branch.
6. The new branch becomes the active continuation.

## Semantic scope
The sanitizer operates over one raw eligible message text at a time, not over structured context records.

Eligible text:
- message text for `SessionEntry.type === "message"` entries whose role is `user` or `assistant`

Not eligible by default:
- the system prompt
- retained summary text
- `SessionEntry.type !== "message"` entries
- injected tool calls, skill docs, agents.md-style content, or other agent-authored metadata
- code artifacts, file diffs, or task outputs that are not eligible user/assistant message text

When in doubt, preserve the message structure and let the sanitizer only rewrite the text of eligible user/assistant turns.

The sanitizer output is pure cleaned text only. Code owns the original structure and applies the cleaned text back to each message.

## Design constraints
- The old branch remains available for audit/history.
- The new branch should look like an ordinary continuation.
- No tombstones, tags, or “forgotten” markers should be introduced into model-visible context.
- Sanitization must run in a separate transient session/context, not inside the contaminated working session.
- The sanitizer is one-shot and non-persistent.
- The sanitizer should emit pure cleaned text for one eligible message at a time, not the final cleaned branch context.
- Code must reconstruct the cleaned context from the original structure plus those cleaned message texts.
- If the cleanup requires a summary for navigation, keep it outside the LLM-visible continuation branch.

## Implementation sketch
- Use session tree inspection to gather the eligible user/assistant message texts that need cleaning.
- Use `ctx.navigateTree(...)` when the user needs to choose among branches or to move to a specific point in the tree.
- Clean eligible user and assistant message text one message at a time.
- Leave the system prompt and retained summary untouched.
- Rebuild the cleaned `messages` in code from the original structure and the sanitizer outputs.
- Create a fresh continuation session/branch using Pi’s supported session-creation API (`ctx.fork(...)` or `ctx.newSession()` as appropriate for the current runtime path).
- Seed the new branch with the reconstructed context as the only model-visible continuation state.
- Reconstruct any extension-local state from the active branch after the branch is created.
- Treat the newly created branch as the only future context source.

## Prompt templates

### Main orchestration prompt
```text
You are coordinating a transient sanitizer session for a Pi `/forget` operation.

Task:
- Given one message text and the fuzzy user query, clean only the message text.
- Leave the system prompt untouched.
- The sanitizer session is isolated, one-shot, and non-persistent.
- Do not modify the main session.
- Do not write files.
- Do not mention or surface the existence of `/forget` to the model-visible continuation branch.

Input:
- fuzzy query
- role of the message (user or assistant)
- the raw message text

Output:
- Return only the cleaned text for that single message.
- If the entire message should be removed, return an empty string.
- Do not wrap the answer in JSON or markdown.

Constraints:
- Preserve meaning unless it is stale/conflicting.
- Be conservative; remove only the text that plausibly causes future confusion.
- Do not include chain-of-thought or hidden reasoning.
```

### Sanitizer prompt
```text
You are a transient sanitizer session for a Pi `/forget` workflow.

Goal:
- Clean only the provided raw message text.
- Preserve the message format; do not author any structured context.
- Prefer the smallest cleaned version that preserves useful meaning.

Rules:
- Do not modify the main session.
- Do not write files.
- Do not persist state.
- Do not invent new transcript content.
- Do not explain chain-of-thought.
- If nothing should remain, return an empty string.
- If no safe cleanup exists, return the original text unchanged.

Output format:
- Return only cleaned text.
- Do not wrap the answer in JSON or markdown.
```

### Reconstruction contract
- Code reconstructs `cleanContext.systemPrompt` by copying it unchanged from the source context.
- Code reconstructs `cleanContext.retainedSummary` by copying it unchanged from the source context.
- Code reconstructs `cleanContext.messages` by keeping custom entries unchanged and replacing only user/assistant message content with the sanitizer’s cleaned text.
- The sanitizer output is plain text only and must not be injected into the new branch as metadata.

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
- The new branch is seeded only from the reconstructed context artifact.
- The reconstructed context artifact is the source of truth for what future turns inherit.

## Acceptance criteria
- `/forget` produces a new cleaned branch, not a rewritten transcript.
- The new branch contains no visible `/forget` message.
- The old branch is preserved.
- The agent does not see tombstones or deletion notes in future context.
- The new branch is seeded from deterministic reconstruction, not by mutating the old branch in place.
- The sanitizer only sees one eligible message text at a time, and a single `/forget` call sweeps the whole applicable eligible message list.
- The sanitizer never needs to emit the final `systemPrompt` / `messages` structure.
- No direct JSONL mutation is performed.
