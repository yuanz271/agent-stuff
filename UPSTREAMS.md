# Upstream Pins

This file records the last checked upstream commit for each imported skill or extension.
Entries may include an upstream path hint when the upstream layout differs from the local one.
Run `scripts/check-import-upstreams.py` to refresh it after checking upstreams.

- `goal` → `https://github.com/mitsuhiko/agent-stuff` @ `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` (`origin/main`) [upstream `extensions/goal.ts`]
- `files` → `https://github.com/mitsuhiko/agent-stuff` @ `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` (`origin/main`) [upstream `extensions/files.ts`]
- `control` → `https://github.com/mitsuhiko/agent-stuff` @ `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` (`origin/main`) [upstream `extensions/control.ts`]
- `loop` → `https://github.com/mitsuhiko/agent-stuff` @ `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` (`origin/main`) [upstream `extensions/loop.ts`]
- `session-breakdown` → `https://github.com/mitsuhiko/agent-stuff` @ `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (`origin/main`) [upstream `extensions/session-breakdown.ts`]
- `prompt-editor` → `https://github.com/mitsuhiko/agent-stuff` @ `4bce45560fa55ace2f5dc8634a63a2af464ddc8b` (`origin/main`) [upstream `extensions/prompt-editor.ts`]
- `pi-review` → `https://github.com/earendil-works/pi-review` @ `6557ef2` (`origin/main`)
- `side-chat` → `https://github.com/nicobailon/pi-side-chat` @ `58f833f1b3ae05ae91257ed0f4117e1ee41d25cb` (`origin/main`)
- `pi-schedule-prompt` → `https://github.com/tintinweb/pi-schedule-prompt` @ `5556775276202c26654ff9323541fe6983f6ee38` (`origin/master`)
- `liteparse` → `https://github.com/run-llama/llamaparse-agent-skills` @ `2dcef7c` (`origin/main`)

## Latest Review

- `mitsuhiko/agent-stuff` @ `4bce455`: reviewed the new `extensions/continue.ts`; intentionally not imported because its idle-only manual continuation shortcut is not useful locally. Upstream changes to the excluded `edit` extension remain excluded.
- `earendil-works/pi-review` @ `6557ef2`: reviewed; its import migration was already present locally.
- `run-llama/llamaparse-agent-skills` @ `2dcef7c`: reviewed; LiteParse's name/version-only update was intentionally skipped to retain the local `effective-liteparse` name.
