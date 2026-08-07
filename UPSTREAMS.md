# Upstream Pins

This file records the last checked upstream commit for each imported skill or extension.
Entries may include an upstream path hint when the upstream layout differs from the local one.
Run `scripts/check-import-upstreams.py` to refresh it after checking upstreams.

- `goal` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/goal.ts`]
- `files` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/files.ts`]
- `control` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/control.ts`]
- `loop` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/loop.ts`]
- `session-breakdown` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/session-breakdown.ts`]
- `prompt-editor` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/prompt-editor.ts`]
- `pi-review` → `https://github.com/earendil-works/pi-review` @ `f1de050504936046c0f85b21fec0e0a93ef394eb` (`origin/main`)
- `side-chat` → `https://github.com/nicobailon/pi-side-chat` @ `58f833f1b3ae05ae91257ed0f4117e1ee41d25cb` (`origin/main`)
- `pi-schedule-prompt` → `https://github.com/tintinweb/pi-schedule-prompt` @ `5556775276202c26654ff9323541fe6983f6ee38` (`origin/master`)
- `liteparse` → `https://github.com/run-llama/llamaparse-agent-skills` @ `2dcef7c62417bd2ec4671fce4621bb1e8cce48d0` (`origin/main`)

## Import Policy

Upstream extensions and skills absent from this repository are intentionally excluded unless explicitly listed for review. Do not infer that an absent item is a missed import; compare upstream history only to identify genuinely new or changed candidates. Current exception: `extensions/subagent.ts` is intentionally pending review.

## Latest Review

- `mitsuhiko/agent-stuff` @ `d265b8e`: synced the current `goal.ts`, `control.ts`, `prompt-editor.ts`, and `session-breakdown.ts`; all other absent upstream extensions and skills remain intentionally excluded except `extensions/subagent.ts`, which is pending review.
- `earendil-works/pi-review` @ `f1de050`: synced the clean-code review guidelines into `pi-extensions/pi-review/review.ts`.
- `run-llama/llamaparse-agent-skills` @ `2dcef7c`: reviewed; LiteParse's name/version-only update was intentionally skipped to retain the local `effective-liteparse` name.
