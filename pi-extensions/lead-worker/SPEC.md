# Lead-Worker Spec
*Architecture, protocol semantics, and supervision design for the current repo-scoped lead-worker extension.*

## Summary

`lead-worker` uses a repo-scoped paired lead/worker architecture over a worker-owned Unix domain socket with typed framed messages.

The whole point of the extension is to let the worker run autonomously. `/worker build` is therefore always supervised by the lead via event analysis and steering.

## Implementation structure

The current implementation is intentionally split by concern:

| File | Responsibility |
|---|---|
| `runtime.ts` | shared runtime state (`rt`), shared types, repo-wide constants, and small cross-cutting helpers |
| `control.ts` | lead mode lifecycle, status rendering, tool/model switching, and lead-only control actions |
| `execution-updates.ts` | structured execution-update payload schema, parsing, and rendering helpers |
| `relay.ts` | worker event surfacing, reply prompting, worker status formatting, and passive `/worker status` |
| `supervision.ts` | outcome synthesis, supervision analysis, and event queue handling |
| `index.ts` | transport/RPC, queued event delivery, worker socket server, handoff/build orchestration, and extension registration |

`index.ts` deliberately still owns transport and extension wiring in the first refactor pass because those paths remain the most coupled and correctness-sensitive.

## Architecture

### Roles
- **lead** — inspection-oriented session; holds the spec, initiates delegation, and steers the worker while avoiding direct repo edits (may operate autonomously during supervised worker execution)
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
~/.pi/lead-worker-sockets/<pair-id-prefix>/protocol-v2/worker.sock
```

The worker socket uses a short user-scoped runtime path so deep repository roots cannot exceed AF_UNIX path limits.

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
- reply for unknown id → protocol error and connection reset

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
`handoff` is the structured delegation primitive. The lead writes the full spec to a repo-local artifact under `.pi/lead-worker/<pair-id-prefix>/handoffs/<handoff-id>.md`, then sends a typed `handoff` command carrying the `handoffId`, artifact path, artifact digest, and a short summary/pointer body. The worker validates the artifact before accepting it, then starts executing and emits typed progress events back.

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

### Structured execution-update payloads
Worker high-signal events (`completed`, `failed`, `cancelled`, `blocker`, `clarification_needed`) must carry a structured payload tagged as `lead-worker/execution-update@1`. `message.body` is only the short human summary; the payload is the source of truth for rendering and supervision.

```ts
type ValidationRecord = {
  command: string;
  result: "passed" | "failed" | "skipped";
  details?: string;
};

type TerminalExecutionUpdate = {
  schema: "lead-worker/execution-update@1";
  kind: "terminal";
  status: "completed" | "failed" | "cancelled";
  handoffId: string;
  summary: string;
  filesChanged: string[];
  validation: ValidationRecord[];
  nextStep?: string;
  handoffArtifactPath?: string;
  handoffArtifactSha256?: string;
};

type AttentionExecutionUpdate = {
  schema: "lead-worker/execution-update@1";
  kind: "attention";
  status: "blocker" | "clarification_needed";
  handoffId: string;
  summary: string;
  nextStep: string;
  blocker?: string;
  question?: string;
  filesChanged?: string[];
  validation?: ValidationRecord[];
  handoffArtifactPath?: string;
  handoffArtifactSha256?: string;
};
```

Invariants:
- terminal payloads must include `filesChanged` and `validation`
- `blocker` must include `blocker`
- `clarification_needed` must include `question`
- renderer and supervision consume the structured payload directly rather than parsing the summary text

### Clarification state
Unresolved worker clarification is tracked as semantic handoff state, not only as an in-memory transport detail.

- live worker `ask` requests are surfaced as `waiting for clarification` while the reply path is still active
- if the worker issues `ask` while no lead is attached, it automatically degrades into durable `clarification_needed` state and is queued for later delivery
- if the worker reports `clarification_needed`, the unresolved question from the structured payload is persisted in `worker-state.json`
- persisted clarification state survives reconnects/resume and appears in `/worker status`
- persisted state does **not** preserve raw `replyTo` ids; after resume, status may show the unresolved question even when an immediate `reply` is no longer possible
- lead-side supervision pauses steering/escalation while clarification remains unresolved, and resumes after reply or terminal outcome
- new accepted handoffs, terminal worker events, explicit interrupts, and worker stop clear clarification state

### Lead → worker steering
When lead-side supervision decides to steer, it sends a `message` event to the worker via `lead_worker({ action: "message", name: "steer", message: "..." })`. This is not a named worker event but a lead-originated event delivered over the same protocol channel.

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
3. Write the full handoff to a repo-local artifact and compute its SHA-256 digest
4. Validate that lead-side supervision can run with the active lead model and credentials
5. Register lead-side supervision state before issuing the handoff so early worker events cannot be missed
6. Send `handoff` command with artifact metadata → wait for worker ack
7. Synthesize a one-line outcome string from the handoff spec using a cheap model call
8. Analyze meaningful worker events and steer when needed

### Lead-side supervision
The lead analyzes incoming worker events against the handoff spec:

- input: handoff spec + recent worker events
- model: **current lead model** — heavier, context-aware, appropriate for cross-run goal validation
- auth/availability: if the active lead model is unavailable or lacks credentials, supervision fails fast and surfaces an explicit error rather than silently downgrading to unsupervised execution
- output: `{ action: "continue" | "steer" | "done" | "escalate", message?, confidence, reasoning }`
- trigger: on every meaningful worker event (`progress`, `blocker`, `clarification_needed`, terminal)
- clarification pause: if the worker is explicitly waiting for clarification on the active handoff, supervision records the event but pauses steering/escalation until the clarification is resolved or a terminal event arrives
- concurrency: events are analyzed serially per handoff so bursts of `progress` updates cannot race into duplicate steering or premature escalation
- queue policy: queued supervision events are bounded structurally by coalescing same-kind updates (`progress`, `blocker`, `clarification_needed`), while terminal events preempt only stale `progress` and retain queued `blocker` / `clarification_needed` context for final analysis

Actions:
- `continue` → stay silent
- `steer` → send steering message to worker via `lead_worker({ action: "message" })`
- `done` → confirm goal met, notify human, stop watching
- `escalate` → surface to human lead with summary after repeated failed steering attempts

### Outcome string derivation
When no explicit instructions are given to `/worker build`, the outcome string is synthesized from the handoff spec via a **cheap Haiku model call** — one-shot, low-cost, accurate enough for a one-line outcome statement. This is intentionally a different model from the lead-side event analysis, which uses the current lead model for deeper context-aware judgment.

### Single lead-owned supervision layer

| Component | Responsibility |
|---|---|
| Lead | holds spec, observes worker events, decides `continue`/`steer`/`done`/`escalate` |
| Worker | executes, emits typed events, accepts `steer`, asks for clarification, reports terminal outcome |

This keeps lead-worker supervision observable and attributable:
- the lead owns the control policy
- the worker remains a transparent executor
- every correction is visible on the paired channel

---

## Public surface

### Slash commands
- `/lead [start|on|status|off|stop]` — lead mode control
- `/worker status` — passive worker status query; uses direct protocol status when available, never auto-starts the worker, and shows pending clarification state
- `/worker build [instructions]` — supervised task delegation
- `/worker /<command>` — escape hatch for worker-local slash commands

### Tool
`lead_worker(...)` actions:
- control (lead-only): `start`, `on`, `status`, `off`, `stop`
- communication: `message`, `ask`, `command`, `reply`

`action: "message"` may include an optional object `payload`. For worker high-signal events, that structured payload is required.

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
- handoff artifacts remain on disk under the repo-local lead-worker runtime directory for inspection/debugging across reconnects and resume
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
11. `/worker build` activates lead-side supervision state immediately after handoff ack
12. outcome string is synthesized correctly from lead context
13. lead-side supervision analyzes `progress` as well as blocker/terminal events
14. lead-side steer is delivered to worker and visible in worker session
15. lead-side escalation surfaces to human when stagnation threshold is reached

---

## Decision summary

- repo-scoped paired lead/worker architecture
- worker-owned Unix socket with framed typed messages
- protocol v2: `request` / `reply` / `command` / `event`
- stable repo-scoped `pairId`, not lead-session identity
- same-lead reconnect takes over cleanly; different-lead gets busy error
- worker events queued to disk across lead disconnects
- `/worker build` is always supervised — no unsupervised delegation
- supervision is lead-owned; the worker does not run a second internal supervisor
- lead-side supervision uses direct model calls on the **current lead model**
- outcome string is synthesized from the handoff spec via cheap **Haiku** call — separate from lead analysis model by design
- escalation follows a lead-owned stagnation policy after repeated unsuccessful steering
- keeping supervision entirely on the lead preserves observability, attribution, and clean role separation
