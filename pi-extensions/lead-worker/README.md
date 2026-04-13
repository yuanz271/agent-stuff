# lead-worker

Lead-worker mode controller for a persistent tmux-backed worker session scoped to the current repository. Supports explicit `start`, `on`, `status`, `off`, and `stop`; bare `/lead` toggles mode on/off; `off` exits lead mode without touching the worker; `stop` stops the paired worker and also exits lead-worker mode if it is on; `/worker build [instructions]` delegates the latest lead context to the worker under lead-owned supervision via event analysis and steering; `/worker status` reports current worker state without auto-starting the worker, uses direct protocol status when available, and surfaces unresolved worker clarification state; `/worker /<command> [args]` runs a registered slash command inside the worker session; and `lead_worker(...)` supports direct paired communication actions: `message` from either side, `ask` from either side, `reply` to answer pending requests, and `command` for lead→worker operational control, while lifecycle control actions remain lead-only.

Worker high-signal events (`completed`, `failed`, `cancelled`, `blocker`, `clarification_needed`) now require a structured `payload` matching `lead-worker/execution-update@1`. `message` remains the short human summary; the payload carries the structured fields the lead renderer and supervision logic rely on.

Worker clarification is modeled as durable handoff state rather than just a transient RPC detail: a live worker `ask` can show up in status while it is pending, an unresolved `clarification_needed` event remains visible across reconnects/resume even when no direct reply handle is available anymore, and if the worker issues `ask` while no lead is attached it automatically degrades into durable `clarification_needed` state instead of failing silently. Lead-side supervision treats that state as waiting rather than drift until the clarification is resolved or a terminal event arrives.

`/worker build` now writes the full handoff spec to a repo-local artifact under `.pi/lead-worker/<pair-id-prefix>/handoffs/<handoff-id>.md` and sends the worker a short pointer packet with the artifact path and SHA-256 digest. That keeps the protocol payload small while leaving the full handoff durable and inspectable on disk.

Structured execution updates are rendered on the lead side as deterministic status cards instead of raw prose blobs, and lead-side supervision consumes the structured fields directly. This makes terminal updates more reliable for both UI surfacing and outcome analysis.

## Settings

Settings are loaded in this order (later layers override earlier ones field-by-field):

1. Bundled defaults (`lead-worker-settings.yaml` in this directory)
2. Global user settings (`~/.pi/agent/lead-worker-settings.yaml`)
3. Nearest project settings discovered from `cwd` upward (`.pi/lead-worker-settings.yaml`, walking to git root)

When lead-worker mode is on, `lead-worker` keeps the `lead_worker` tool active even if lead `allowed_tools` omit it, so the paired lead and worker can communicate over the internal protocol-v2 worker socket. The lead still blocks `write`/`edit` and a small core blacklist of obvious repo-mutating bash commands, but broad inspection/prep commands such as downloads, cloning reference repos, and unpacking archives are intentionally allowed.

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
