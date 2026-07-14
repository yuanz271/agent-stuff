# planner-builder

Planner-builder mode controller for a persistent tmux-backed builder session scoped to the current repository. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/plan` toggles mode on/off; `off` exits planner mode without touching the builder; `stop` stops the paired builder and also exits planner-builder mode if it is on; `/builder build [instructions]` delegates the latest planner context to the builder under planner-owned supervision via event analysis and steering; `/builder status` reports current builder state without auto-starting the builder, uses direct protocol status when available, and surfaces unresolved builder clarification state; `/builder /<command> [args]` runs a registered slash command inside the builder session; and `planner_builder(...)` supports direct paired communication actions: `message` from either side, `ask` from either side, `reply` to answer pending requests, and `command` for planner→builder operational control, while lifecycle control actions remain planner-only.

Builder high-signal events (`completed`, `failed`, `cancelled`, `blocker`, `clarification_needed`) now require a structured `payload` matching `planner-builder/execution-update@1`. `message` remains the short human summary; the payload carries the structured fields the planner renderer and supervision logic rely on.

Builder clarification is modeled as durable handoff state rather than just a transient RPC detail: a live builder `ask` can show up in status while it is pending, an unresolved `clarification_needed` event remains visible across reconnects/resume even when no direct reply handle is available anymore, and if the builder issues `ask` while no planner is attached it automatically degrades into durable `clarification_needed` state instead of failing silently. Planner-side supervision treats that state as waiting rather than drift until the clarification is resolved or a terminal event arrives.

`/builder build` now writes the full handoff spec to a repo-local artifact under `.pi/planner-builder/<pair-id-prefix>/handoffs/<handoff-id>.md` and sends the builder a short pointer packet with the artifact path and SHA-256 digest. That keeps the protocol payload small while leaving the full handoff durable and inspectable on disk.

Structured execution updates are rendered on the planner side as deterministic status cards instead of raw prose blobs, and planner-side supervision consumes the structured fields directly. This makes terminal updates more reliable for both UI surfacing and outcome analysis.

## Settings

Settings are loaded in this order (later layers override earlier ones field-by-field):

1. Bundled defaults (`planner-builder-settings.yaml` in this directory)
2. Global user settings (`~/.pi/agent/planner-builder-settings.yaml`)
3. Nearest project settings discovered from `cwd` upward (`.pi/planner-builder-settings.yaml`, walking to git root)

When planner-builder mode is on, `planner-builder` keeps the `planner_builder` tool active even if planner `allowed_tools` omit it, so the paired planner and builder can communicate over the internal protocol-v2 builder socket. The planner still blocks `write`/`edit` and a small core blacklist of obvious repo-mutating bash commands, but broad inspection/prep commands such as downloads, cloning reference repos, and unpacking archives are intentionally allowed.

For builder settings, prefer separate `model` and `thinking` fields. Legacy combined shorthand like `model: openai/gpt-5.3-codex:off` is still accepted and normalized for backward compatibility. Runtime builder naming is fixed internally and stable per repository pair id, so the same repo reuses the same builder identity across planner reconnects.

## Example configuration

```yaml
planner:
  model: anthropic/claude-opus-4-6
  thinking: high
  allowed_tools:
    - read
    - grep
    - find
    - ls
    - websearch
  prompt_append: |
    Prefer small, reviewable implementation plans.

builder:
  model: openai/gpt-5.3-codex
  thinking: off
  system_prompt_append: |
    Prefer the smallest relevant validation first.
  startup_prompt_append: |
    Report readiness briefly, then wait.
```
