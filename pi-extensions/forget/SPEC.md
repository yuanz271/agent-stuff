# Forget Extension Spec

`/forget <query>` calls this extension's copied compaction implementation directly.

Source policy:
- `core.ts` is copied from `earendil-works/pi/packages/coding-agent/src/core/compaction/compaction.ts`.
- General-purpose support from Pi is imported from `@earendil-works/pi-coding-agent` instead of vendored (`buildSessionContext`, `convertToLlm`, `serializeConversation`, and session entry types).
- Local semantic differences from Pi compaction are limited to:
  1. `findCutPoint(...)` ignores a trailing user `/forget` command when computing the retained/summarized boundary;
  2. prompt text asks for cleanup/removal of forgotten content instead of ordinary summarization;
  3. imports are relinked to Pi's public package exports, with small local file-operation helpers retained because Pi does not publicly export those helper functions.

Behavior:
1. `/forget <query>` validates the query and waits for the session to be idle.
2. The command loads the current branch using the same shape as Pi compaction; the core cut-point logic ignores a trailing `/forget` command.
3. The command prepares cleanup from those entries using extension-local `prepareForgetting(...)`.
4. The command runs extension-local `forget(...)` with cleanup/removal prompt text.
5. The command appends the resulting compaction entry directly to the session manager with `fromHook: true`.
6. The command reloads the current session file so the active agent context reflects the new compaction entry.

Important constraint:
- `/forget` must not call `ctx.compact(...)` or Pi's compaction pipeline. `index.ts` calls extension-local `prepareForgetting(...)` and `forget(...)` from `./core.ts`.

Non-goals:
- no custom branch-state format
- no transient sanitizer branch
- no direct JSONL text rewriting
- no model-authored session object reconstruction
