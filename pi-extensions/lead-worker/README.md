# lead-worker

Lead-worker mode controller for a persistent tmux-backed worker session scoped to the current lead session. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/lead` toggles mode on/off; `off` exits lead mode without touching the worker; `stop` stops the paired worker and also exits lead-worker mode if it is on; `/build` delegates the latest lead context to the worker; and lead↔worker direct messages use an internal session-scoped mailbox via `lead_worker({ action: "message", ... })`.

## Settings

Settings are loaded in this order (later layers override earlier ones field-by-field):

1. Bundled defaults (`lead-worker-settings.yaml` in this directory)
2. Global user settings (`~/.pi/agent/lead-worker-settings.yaml`)
3. Nearest project settings discovered from `cwd` upward (`.pi/lead-worker-settings.yaml`, walking to git root)

When lead-worker mode is on, `lead-worker` keeps the `lead_worker` tool active even if lead `allowed_tools` omit it, so the paired lead and worker can exchange direct messages through the internal lead-worker mailbox.

For worker settings, prefer separate `model` and `thinking` fields. Legacy combined shorthand like `model: openai/gpt-5.3-codex:off` is still accepted and normalized for backward compatibility. Runtime worker naming is fixed internally and suffixed per lead session so different lead sessions do not share a worker.

## Example configuration

```yaml
lead:
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

worker:
  model: openai/gpt-5.3-codex
  thinking: off
  system_prompt_append: |
    Prefer the smallest relevant validation first.
  startup_prompt_append: |
    Report readiness briefly, then wait.
```
