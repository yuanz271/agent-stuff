# Lead-Worker Spec
*Architecture, protocol semantics, and supervision design for the current repo-scoped lead-worker extension.*

## Summary

`lead-worker` uses a repo-scoped paired lead/worker architecture over a worker-owned Unix domain socket with typed framed messages.

The whole point of the extension is to let the worker run autonomously. `/worker build` is therefore always supervised — both on the worker side (via `pi-supervisor`) and on the lead side (via event analysis).

## Prerequisites

- **`pi-supervisor` must be installed** in the worker session for worker-side supervision to function. Without it, `/worker build` will still delegate and the lead-side analysis will still run, but the worker will not self-correct mid-run.

## Architecture

### Roles
- **lead** — read-only session; holds the spec, initiates delegation, and steers the worker (may operate autonomously during supervised worker execution)
- **worker** — persistent tmux-backed session; executes tasks; emits typed progress events

### Why worker-owned socket
- worker is the durable endpoint; lead is a transient client
- low-latency request/reply and truthful command acks
- worker survives lead disconnects and reconnects

### Ownership model
- worker owns the socket server; lead is the client
- one worker allows one active lead session at a time
- same-lead reconnect replaces stale socket cleanly
- different lead session gets a busy error
- ownership released on socket `close` / `error`

### Socket location

```text
<repo>/.pi/lead-worker/<pair-id>/protocol-v2/worker.sock
```

`pair-id = sha256(realpath(projectRoot) + ":default")`  
Full hash is protocol identity; filesystem paths use a short prefix.

---

## Protocol

### Message types
- `request` — blocking question expecting exactly one reply
- `reply` — response to a `request` or `command`
- `command` — imperative operational instruction expecting exactly one reply
- `event` — unsolicited notification with no reply expected

### Schema

```ts
type PairMessageV2 = {
  version: 2;
  id: string;
  type: "request" | "reply" | "command" | "event";
  from: "lead" | "worker";
  to: "lead" | "worker";
  pairId: string;
  timestamp: string;
  name?: string;      // required for command and event
  body?: string;
  payload?: unknown;
  replyTo?: string;   // required for reply
  ok?: boolean;       // required for reply
  error?: string;
  handoffId?: string;
};
```

### Invariants
1. Every `request` / `command` receives exactly one `reply`.
2. `reply.replyTo` must reference a known in-flight id.
3. `event` messages never expect replies.
4. `from`, `to`, `pairId` must match the active pair context.
5. `name` required for `command` and `event`.
6. `replyTo` and `ok` required for `reply`.
7. Unknown type or missing required fields are protocol errors.
8. Malformed messages are connection-fatal.

### Framing
- 4-byte big-endian length prefix
- UTF-8 JSON payload
- max frame: 256 KB

### Request lifecycle
- sender allocates `id`, records pending RPC, sends
- receiver emits exactly one reply
- default timeout: 10 minutes
- expired RPC → stale reply is warned and ignored
- reply for unknown id → protocol error

---

## Command set

### Worker commands
- `attach` — lead connects and identifies its session
- `status` — worker runtime summary
- `interrupt` — abort current worker turn
- `thinking` — set thinking level
- `model` — set model
- `handoff` — structured task delegation primitive
- `slash_command` — escape hatch for worker-local slash commands

### Why `handoff` is the delegation primitive
`handoff` carries the full spec — goal, files, constraints, validation criteria, `handoffId` — as a single typed command. The worker accepts it, starts executing, and emits typed progress events back.

### `slash_command` policy
Exists to preserve coverage without mirroring every worker slash command into the protocol. Keep as escape hatch only.

---

## Worker events

Worker → lead events carry `handoffId` when associated with a delegated task.

### Event names
- `readiness` — worker started and ready
- `progress` — interim execution update
- `blocker` — worker cannot continue without input
- `clarification_needed` — worker needs a decision
- `completed` — terminal: task done successfully
- `failed` — terminal: task could not be completed
- `cancelled` — terminal: task was abandoned
- `busy` — rejected second-lead attachment attempt

### Lead → worker steering
When the lead-side supervisor decides to steer, it sends a `message` event to the worker via `lead_worker({ action: "message", name: "steer", message: "..." })`. This is not a named worker event but a lead-originated event delivered over the same protocol channel.

### Terminal vs interim
Each handoff emits zero or more interim events and exactly one terminal event.

---

## `/worker build` — supervised delegation

`/worker build` is the primary delegation command. It always runs supervised.

### Why always supervised
The whole point of `lead-worker` is autonomous worker execution. An unsupervised handoff is just blind delegation — the lead would have no way to detect drift or confirm the goal is actually met.

### What it does

1. Gather recent lead context
2. Build spec-oriented handoff with `handoffId`
3. Send `handoff` command → wait for worker ack
4. Synthesize a one-line outcome string from the handoff spec using a cheap model call
5. Send `slash_command` `/supervise <outcome>` → activates `pi-supervisor` on worker side
6. Activate lead-side event analysis

### Worker-side supervision (`pi-supervisor`)
- requires `pi-supervisor` installed in the worker session (see Prerequisites)
- watches the worker's own tool cycles for mid-run drift
- corrects within the run before the worker goes idle
- signals done when the stated outcome is met

### Lead-side supervision
The lead analyzes incoming worker events against the handoff spec:

- input: handoff spec + recent worker events
- model: **current lead model** — heavier, context-aware, appropriate for cross-run goal validation
- output: `{ action: "continue" | "steer" | "done" | "escalate", message?, confidence, reasoning }`
- trigger: on every meaningful worker event (`progress`, `blocker`, `clarification_needed`, terminal)

Actions:
- `continue` → stay silent
- `steer` → send steering message to worker via `lead_worker({ action: "message" })`
- `done` → confirm goal met, notify human, stop watching
- `escalate` → surface to human lead with summary (follows `pi-supervisor` stagnation policy)

### Outcome string derivation
When no explicit instructions are given to `/worker build`, the outcome string is synthesized from the handoff spec via a **cheap Haiku model call** — one-shot, low-cost, accurate enough for a one-line outcome statement. This is intentionally a different model from the lead-side event analysis, which uses the current lead model for deeper context-aware judgment.

### Two-layer supervision

| Layer | Watches | Corrects | Decides done |
|---|---|---|---|
| Worker-side (`pi-supervisor`) | worker's own tool cycles | mid-run drift | worker thinks it's done |
| Lead-side (event analysis) | typed worker→lead events | wrong direction / wrong goal | lead confirms goal is met |

The layers are complementary:
- worker-side catches micro-drift within a run
- lead-side catches macro-drift across runs and validates the final result

---

## Public surface

### Slash commands
- `/lead [start|on|status|off|stop]` — lead mode control
- `/worker status` — direct worker status query
- `/worker build [instructions]` — supervised task delegation
- `/worker /<command>` — escape hatch for worker-local slash commands

### Tool
`lead_worker(...)` actions:
- control: `start`, `on`, `status`, `off`, `stop`
- communication: `message`, `ask`, `command`, `reply`

---

## Error semantics

### Hard / connection-fatal
- invalid frame length or oversized frame
- invalid JSON
- schema mismatch
- invalid `from` / `to`
- invalid active-lead ownership
- reply without valid `replyTo`
- reply for unknown id
- wrong `pairId`
- duplicate resolution of same request

### Recoverable / operational error reply
- unknown command name
- ambiguous model reference
- unavailable model / auth
- worker refused due to runtime state

---

## State and recovery

- worker is tmux-backed and durable; socket lifetime follows the live process
- lead reconnect is a new transport connection to the same `pairId`
- same-lead reconnect: takes over stale socket, flushes queued worker events
- different-lead reconnect: busy error
- in-flight RPCs on disconnected lead fail immediately
- worker events while lead is disconnected are queued to disk and flushed on reattach
- stale `worker.sock` is cleaned on worker startup and on `/lead stop`
- compact lead status shows logical state only, not full tmux session names

---

## Validation

1. worker startup creates socket and accepts one lead
2. same-lead reconnect replaces stale ownership and flushes queued events
3. different-lead attach is rejected with busy error
4. blocking `ask` / `command` round-trips succeed
5. command success/error replies are truthful
6. worker events surface on lead side correctly
7. malformed frames/messages fail loudly
8. expired replies are warned and ignored; unknown replies are hard errors
9. disconnect rejects in-flight RPCs promptly
10. queued worker events are replayed after reconnect
11. `/worker build` activates both worker-side and lead-side supervision
12. outcome string is synthesized correctly from lead context
13. lead-side steer is delivered to worker and visible in worker session
14. lead-side escalation surfaces to human when stagnation threshold is reached

---

## Decision summary

- repo-scoped paired lead/worker architecture
- worker-owned Unix socket with framed typed messages
- protocol v2: `request` / `reply` / `command` / `event`
- stable repo-scoped `pairId`, not lead-session identity
- same-lead reconnect takes over cleanly; different-lead gets busy error
- worker events queued to disk across lead disconnects
- `/worker build` is always supervised — no unsupervised delegation
- worker-side supervision via `pi-supervisor` (must be installed in worker session)
- lead-side supervision via direct model call on **current lead model**
- outcome string synthesized from handoff spec via cheap **Haiku** call — separate from lead analysis model by design
- escalation follows `pi-supervisor` stagnation policy
- `pi-supervisor` as a standalone top-level extension is redundant once lead-worker supervision is implemented; it should be retired from the extension list at that point, kept only as a worker-session dependency
