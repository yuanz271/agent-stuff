# Upstream Pins

This file records the last checked upstream commit for each imported skill or extension.
Entries may include an upstream path hint when the upstream layout differs from the local one.
A pin is current when it is not behind the configured upstream branch head; local source customizations and intentionally omitted non-source files do not make an import stale.
Run `scripts/check-import-upstreams.py` to refresh it after checking upstreams.

- `discuss` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `commands/discuss.md`]
- `goal` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/goal.ts`]
- `files` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/files.ts`]
- `control` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/control.ts`]
- `prompt-editor` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/prompt-editor.ts`]
- `pi-review` → `https://github.com/earendil-works/pi-review` @ `f1de050504936046c0f85b21fec0e0a93ef394eb` (`origin/main`)
- `side-chat` → `https://github.com/nicobailon/pi-side-chat` @ `58f833f1b3ae05ae91257ed0f4117e1ee41d25cb` (`origin/main`)
- `pi-schedule-prompt` → `https://github.com/tintinweb/pi-schedule-prompt` @ `5556775276202c26654ff9323541fe6983f6ee38` (`origin/master`)
- `liteparse` → `https://github.com/run-llama/llamaparse-agent-skills` @ `2dcef7c62417bd2ec4671fce4621bb1e8cce48d0` (`origin/main`)
- `commit` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/commit`]
- `github` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/github`]
- `librarian` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/librarian`]
- `summarize` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/summarize`]
- `tmux` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/tmux`]
- `update-changelog` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/update-changelog`]
- `uv` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `skills/uv`]

## Excluded Upstream Items

These are explicit exclusions, not missing imports. Each item is pinned to the upstream head last reviewed. Any upstream extension or skill not listed here or in the imported pins is an unreviewed candidate and must be reported.

### `mitsuhiko/agent-stuff` @ `d265b8e`

#### Extensions

- `extensions/answer.ts` — excluded; not used locally.
- `extensions/btw.ts` — excluded; local `side-chat` provides the needed side-chat workflow.
- `extensions/continue.ts` — excluded; the idle-only manual continuation shortcut is not useful locally.
- `extensions/no-sleep.ts` — excluded; local `no-bash-sleep.ts` enforces the relevant sleep policy with different behavior.
- `extensions/notify.ts` — excluded; not used locally.
- `extensions/review.ts` — excluded; local `pi-extensions/pi-review` is imported from `earendil-works/pi-review`.
- `extensions/session-breakdown.ts` — excluded; removed because it is not used locally.
- `extensions/split-fork.ts` — excluded; not used locally.
- `extensions/subagent.ts` — excluded; `npm:pi-subagents` provides the needed delegation and orchestration features.
- `extensions/todos.ts` — excluded; not used locally.
- `extensions/trust-github-repos.ts` — excluded; not used locally.
- `extensions/unified-edit.ts` — excluded; not used locally.
- `extensions/uv.ts` — excluded; not used locally.
- `extensions/whimsical.ts` — excluded; not used locally.

#### Skills

- `skills/anachb` — excluded; not used locally.
- `skills/apple-mail` — excluded; not used locally.
- `skills/audio-transcription` — excluded; not used locally.
- `skills/frontend-design` — excluded; not used locally.
- `skills/ghidra` — excluded; not used locally.
- `skills/google-workspace` — excluded; not used locally.
- `skills/native-web-search` — excluded; not used locally.
- `skills/oebb-scotty` — excluded; not used locally.
- `skills/openscad` — excluded; not used locally.
- `skills/pi-share` — excluded; not used locally.
- `skills/sentry` — excluded; not used locally.
- `skills/web-browser` — excluded; not used locally.

## Import Policy

Every upstream extension and skill must be listed either in the imported pins above or in **Excluded Upstream Items**. A new upstream item without either entry is an unreviewed candidate; do not silently treat it as excluded. Non-source upstream files may be omitted, and imported source may use the `@earendil-works/*` packages required by Pi.

## Latest Review

- `mitsuhiko/agent-stuff` @ `d265b8e`: imported `commands/discuss.md`, synced `goal.ts`, `control.ts`, and `prompt-editor.ts`, removed the obsolete local `loop.ts` and `session-breakdown.ts`, and reviewed the explicit exclusions above.
- `earendil-works/pi-review` @ `f1de050`: synced the clean-code review guidelines into `pi-extensions/pi-review/review.ts`.
- `run-llama/llamaparse-agent-skills` @ `2dcef7c`: reviewed; LiteParse's name/version-only update was intentionally skipped to retain the local `effective-liteparse` name.
