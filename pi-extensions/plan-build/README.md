# plan-build

Planner/builder mode controller for a persistent tmux-backed builder session scoped to the current planner session. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/plan-build` or `/plan` toggle planner mode on/off; `off` exits planner mode without touching the builder; `stop` stops the paired builder and also exits planner mode if it is on; `/build` delegates the latest planner context to the builder; and planner↔builder direct messages use an internal session-scoped mailbox via `plan_build({ action: "message", ... })`.

## Settings

Settings are loaded in this order (later layers override earlier ones field-by-field):

1. Bundled defaults (`plan-build-settings.yaml` in this directory)
2. Global user settings (`~/.pi/agent/plan-build-settings.yaml`)
3. Nearest project settings discovered from `cwd` upward (`.pi/plan-build-settings.yaml`, walking to git root)

When planner mode is on, `plan-build` keeps the `plan_build` tool active even if planner `allowed_tools` omit it, so the paired planner and builder can exchange direct messages through the internal plan-build mailbox.

For builder settings, prefer separate `model` and `thinking` fields. Legacy combined shorthand like `model: openai/gpt-5.3-codex:off` is still accepted and normalized for backward compatibility. The configured `builder.agent_name` acts as a base name; the runtime builder name is suffixed per planner session so different planner sessions do not share a builder.

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
  agent_name: builder
  model: openai/gpt-5.3-codex
  thinking: off
  system_prompt_append: |
    Prefer the smallest relevant validation first.
  startup_prompt_append: |
    Report readiness briefly, then wait.
```
