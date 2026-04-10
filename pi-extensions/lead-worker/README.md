# lead-worker

Lead-worker mode controller for a persistent tmux-backed worker session scoped to the current repository. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/lead` toggles mode on/off; `off` exits lead mode without touching the worker; `stop` stops the paired worker and also exits lead-worker mode if it is on; `/worker build [instructions]` delegates the latest lead context to the worker with full two-layer supervision (worker-side via `pi-supervisor`, lead-side via event analysis); `/worker status` reports the worker's direct protocol status; `/worker /<command> [args]` runs a registered slash command inside the worker session; and `lead_worker(...)` supports direct paired communication actions: `message` from either side, `ask` from the lead or an attached worker, `reply` to answer pending requests, and `command` for lead→worker operational control.

## Settings

Settings are loaded in this order (later layers override earlier ones field-by-field):

1. Bundled defaults (`lead-worker-settings.yaml` in this directory)
2. Global user settings (`~/.pi/agent/lead-worker-settings.yaml`)
3. Nearest project settings discovered from `cwd` upward (`.pi/lead-worker-settings.yaml`, walking to git root)

When lead-worker mode is on, `lead-worker` keeps the `lead_worker` tool active even if lead `allowed_tools` omit it, so the paired lead and worker can communicate over the internal protocol-v2 worker socket.

For worker settings, prefer separate `model` and `thinking` fields. Legacy combined shorthand like `model: openai/gpt-5.3-codex:off` is still accepted and normalized for backward compatibility. Runtime worker naming is fixed internally and stable per repository pair id, so the same repo reuses the same worker identity across lead reconnects.

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
