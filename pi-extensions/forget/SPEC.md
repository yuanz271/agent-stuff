# Forget Extension Spec

`/forget <query>` runs through Pi's manual compaction UI while supplying this extension's copied compaction implementation as the compaction result.

Source policy:
- `core.ts` is copied from `earendil-works/pi/packages/coding-agent/src/core/compaction/compaction.ts`.
- General-purpose support from Pi is imported from `@earendil-works/pi-coding-agent` instead of vendored (`buildSessionContext`, `convertToLlm`, `serializeConversation`, and session entry types).
- Local semantic differences from Pi compaction are limited to:
  1. `findCutPoint(...)` ignores a trailing user `/forget` command when computing the retained/summarized boundary;
  2. prompt text asks for cleanup/removal of forgotten content instead of ordinary summarization;
  3. imports are relinked to Pi's public package exports, with small local file-operation helpers retained because Pi does not publicly export those helper functions.

Behavior:
1. `/forget <query>` validates the query and calls `ctx.compact(...)` with cleanup/removal instructions so Pi emits the normal manual-compaction UI.
2. During the resulting `session_before_compact` event, the extension ignores Pi's prepared summary payload and prepares cleanup from `event.branchEntries` using extension-local `prepareForgetting(...)`.
3. The core cut-point logic ignores a trailing `/forget` command if one is present in the branch entries.
4. The extension runs extension-local `forget(...)` with cleanup/removal prompt text and returns it as the event's `compaction` result.
5. Pi's built-in compaction path appends the compaction entry, refreshes active agent context, rebuilds chat, and renders the normal compaction summary UI.

Important constraint:
- `/forget` uses Pi's compaction pipeline only for orchestration/UI/persistence. The model cleanup content comes from extension-local `prepareForgetting(...)` and `forget(...)` in `./core.ts`, not Pi's built-in compaction implementation.

Design rationale:
The current design is the tightest fit given Pi's extension constraints:
- Extensions cannot emit internal events, define new event types, or call `appendCompaction(...)` via the public API.
- `compaction_start` / `compaction_end` UI is driven entirely by `AgentSession._emit(...)`, inaccessible to extensions.
- The only way to trigger Pi's compaction UI/lifecycle from an extension is `ctx.compact(...)`.
- `/forget` calls `ctx.compact(...)` to get Pi's full compaction UI/lifecycle for free, intercepts `session_before_compact` to substitute forget-specific content, and lets Pi handle everything else: loader, context refresh, chat rebuild, summary rendering, and persistence.
- The only extension-owned parts are the forget prompt and cutoff logic, which is exactly what should be custom.

Non-goals:
- no custom branch-state format
- no transient sanitizer branch
- no direct JSONL text rewriting
- no model-authored session object reconstruction
