# Planner-Builder Spec
*Architecture, protocol semantics, and supervision design for the current repo-scoped planner-builder extension.*

## Summary

`planner-builder` uses a repo-scoped paired planner/builder architecture over a builder-owned Unix domain socket with typed framed messages.

The whole point of the extension is to let the builder run autonomously. `/builder build` is therefore always supervised by the planner via event analysis and steering.

## Implementation structure

The current implementation is intentionally split by concern:

| File | Responsibility |
|---|---|
| `runtime.ts` | shared runtime state (`rt`), shared types, repo-wide constants, and small cross-cutting helpers |
| `control.ts` | planner mode lifecycle, status rendering, tool/model switching, and planner-only control actions |
| `execution-updates.ts` | structured execution-update payload schema, parsing, and rendering helpers |
| `relay.ts` | builder event surfacing, reply prompting, builder status formatting, and passive `/builder status` |
| `supervision.ts` | outcome synthesis, supervision analysis, and event queue handling |
| `index.ts` | transport/RPC, queued event delivery, builder socket server, handoff/build orchestration, and extension registration |

`index.ts` deliberately still owns transport and extension wiring in the first refactor pass because those paths remain the most coupled and correctness-sensitive.

## Architecture

### Roles
- **planner** — inspection-oriented session; holds the spec, initiates delegation, and steers the builder while avoiding direct repo edits (may operate autonomously during supervised builder execution)
- **builder** — persistent tmux-backed session; executes tasks; emits typed progress events

### Why builder-owned socket
- builder is the durable endpoint; planner is a transient client
- low-latency request/reply and truthful command acks
- builder survives planner disconnects and reconnects

### Ownership model
- builder owns the socket server; planner is the client
- one builder allows one active planner session at a time
- same-planner reconnect replaces stale socket cleanly
- different planner session gets a busy error
- ownership released on socket `close` / `error`

### Socket location

```text
~/.pi/planner-builder-sockets/<pair-id-prefix>/protocol-v2/builder.sock
```

The builder socket uses a short user-scoped runtime path so deep repository roots cannot exceed AF_UNIX path limits.

`pair-id = sha256(realpath(projectRoot) + ":default")`
Full hash is protocol identity; filesystem paths use a short prefix.

### Control plane vs durability plane
`planner-builder` intentionally uses **one interactive transport** and **one durability layer** rather than two competing communication systems.

- **control plane: socket** — all live paired interaction (`request`, `reply`, `command`, `event`) flows over the builder-owned Unix socket
- **durability plane: files** — handoff artifacts, persisted builder state, and queued builder events across planner disconnects live on disk
- files are **not** a second general-purpose mailbox/RPC transport; they exist to preserve state and inspectability when no live socket is attached

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
  from: "planner" | "builder";
  to: "planner" | "builder";
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

### Builder commands
- `attach` — planner connects and identifies its session
- `status` — builder runtime summary
- `interrupt` — abort current builder turn
- `thinking` — set thinking level
- `model` — set model
- `handoff` — structured task delegation primitive
- `slash_command` — escape hatch for builder-local slash commands

### Why `handoff` is the delegation primitive
`handoff` is the structured delegation primitive. The planner writes the full spec to a repo-local artifact under `.pi/planner-builder/<pair-id-prefix>/handoffs/<handoff-id>.md`, then sends a typed `handoff` command carrying the `handoffId`, artifact path, artifact digest, and a short summary/pointer body. The builder validates the artifact before accepting it, then starts executing and emits typed progress events back.

### `slash_command` policy
Exists to preserve coverage without mirroring every builder slash command into the protocol. Keep as escape hatch only.

---

## Builder events

Builder → planner events carry `handoffId` when associated with a delegated task.

### Event names
- `readiness` — builder started and ready
- `progress` — interim execution update
- `blocker` — builder cannot continue without input
- `clarification_needed` — builder needs a decision
- `completed` — terminal: task done successfully
- `failed` — terminal: task could not be completed
- `cancelled` — terminal: task was abandoned
- `busy` — rejected second-planner attachment attempt

### Structured execution-update payloads
Builder high-signal events (`completed`, `failed`, `cancelled`, `blocker`, `clarification_needed`) must carry a structured payload tagged as `planner-builder/execution-update@1`. `message.body` is only the short human summary; the payload is the source of truth for rendering and supervision.

```ts
type ValidationRecord = {
  command: string;
  result: "passed" | "failed" | "skipped";
  details?: string;
};

type TerminalExecutionUpdate = {
  schema: "planner-builder/execution-update@1";
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
  schema: "planner-builder/execution-update@1";
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
Unresolved builder clarification is tracked as semantic handoff state, not only as an in-memory transport detail.

- live builder `ask` requests are surfaced as `waiting for clarification` while the reply path is still active
- if the builder issues `ask` while no planner is attached, it automatically degrades into durable `clarification_needed` state and is queued for later delivery
- if the builder reports `clarification_needed`, the unresolved question from the structured payload is persisted in `builder-state.json`
- persisted clarification state survives reconnects/resume and appears in `/builder status`
- persisted state does **not** preserve raw `replyTo` ids; after resume, status may show the unresolved question even when an immediate `reply` is no longer possible
- planner-side supervision pauses steering/escalation while clarification remains unresolved, and resumes after reply or terminal outcome
- new accepted handoffs, terminal builder events, explicit interrupts, and builder stop clear clarification state

### Planner → builder steering
When planner-side supervision decides to steer, it sends a `message` event to the builder via `planner_builder({ action: "message", name: "steer", message: "..." })`. This is not a named builder event but a planner-originated event delivered over the same protocol channel.

### Terminal vs interim
Each handoff emits zero or more interim events and exactly one terminal event.

---

## `/builder build` — supervised delegation

`/builder build` is the primary delegation command. It always runs supervised.

### Why always supervised
The whole point of `planner-builder` is autonomous builder execution. An unsupervised handoff is just blind delegation — the planner would have no way to detect drift or confirm the goal is actually met.

### What it does

1. Gather recent planner context
2. Build spec-oriented handoff with `handoffId`
3. Write the full handoff to a repo-local artifact and compute its SHA-256 digest
4. Validate that planner-side supervision can run with the active planner model and credentials
5. Register planner-side supervision state before issuing the handoff so early builder events cannot be missed
6. Send `handoff` command with artifact metadata → wait for builder ack
7. Synthesize a one-line outcome string from the handoff spec using a cheap model call
8. Analyze meaningful builder events and steer when needed

### Planner-side supervision
The planner analyzes incoming builder events against the handoff spec:

- input: handoff spec + recent builder events
- model: **current planner model** — heavier, context-aware, appropriate for cross-run goal validation
- auth/availability: if the active planner model is unavailable or lacks credentials, supervision fails fast and surfaces an explicit error rather than silently downgrading to unsupervised execution
- output: `{ action: "continue" | "steer" | "done" | "escalate", message?, confidence, reasoning }`
- trigger: on every meaningful builder event (`progress`, `blocker`, `clarification_needed`, terminal)
- clarification pause: if the builder is explicitly waiting for clarification on the active handoff, supervision records the event but pauses steering/escalation until the clarification is resolved or a terminal event arrives
- concurrency: events are analyzed serially per handoff so bursts of `progress` updates cannot race into duplicate steering or premature escalation
- queue policy: queued supervision events are bounded structurally by coalescing same-kind updates (`progress`, `blocker`, `clarification_needed`), while terminal events preempt only stale `progress` and retain queued `blocker` / `clarification_needed` context for final analysis

Actions:
- `continue` → stay silent
- `steer` → send steering message to builder via `planner_builder({ action: "message" })`
- `done` → confirm goal met, notify human, stop watching
- `escalate` → surface to human planner with summary after repeated failed steering attempts

### Outcome string derivation
When no explicit instructions are given to `/builder build`, the outcome string is synthesized from the handoff spec via a **cheap Haiku model call** — one-shot, low-cost, accurate enough for a one-line outcome statement. This is intentionally a different model from the planner-side event analysis, which uses the current planner model for deeper context-aware judgment.

### Single planner-owned supervision layer

| Component | Responsibility |
|---|---|
| Planner | holds spec, observes builder events, decides `continue`/`steer`/`done`/`escalate` |
| Builder | executes, emits typed events, accepts `steer`, asks for clarification, reports terminal outcome |

This keeps planner-builder supervision observable and attributable:
- the planner owns the control policy
- the builder remains a transparent executor
- every correction is visible on the paired channel

---

## Public surface

### Slash commands
- `/plan [start|on|status|off|stop]` — planner mode control
- `/builder status` — passive builder status query; uses direct protocol status when available, never auto-starts the builder, and shows pending clarification state
- `/builder build [instructions]` — supervised task delegation
- `/builder /<command>` — escape hatch for builder-local slash commands

### Tool
`planner_builder(...)` actions:
- control (planner-only): `start`, `on`, `status`, `off`, `stop`
- communication: `message`, `ask`, `command`, `reply`

`action: "message"` may include an optional object `payload`. For builder high-signal events, that structured payload is required.

---

## Error semantics

### Hard / connection-fatal
- invalid frame length or oversized frame
- invalid JSON
- schema mismatch
- invalid `from` / `to`
- invalid active-planner ownership
- reply without valid `replyTo`
- reply for unknown id
- wrong `pairId`
- duplicate resolution of same request

### Recoverable / operational error reply
- unknown command name
- ambiguous model reference
- unavailable model / auth
- builder refused due to runtime state

---

## State and recovery

- builder is tmux-backed and durable; socket lifetime follows the live process
- planner reconnect is a new transport connection to the same `pairId`
- same-planner reconnect: takes over stale socket, flushes queued builder events
- different-planner reconnect: busy error
- in-flight RPCs on disconnected planner fail immediately
- builder events while planner is disconnected are queued to disk and flushed on reattach
- handoff artifacts remain on disk under the repo-local planner-builder runtime directory for inspection/debugging across reconnects and resume
- stale `builder.sock` is cleaned on builder startup and on `/plan stop`
- compact planner status shows logical state only, not full tmux session names

---

## Validation

1. builder startup creates socket and accepts one planner
2. same-planner reconnect replaces stale ownership and flushes queued events
3. different-planner attach is rejected with busy error
4. blocking `ask` / `command` round-trips succeed
5. command success/error replies are truthful
6. builder events surface on planner side correctly
7. malformed frames/messages fail loudly
8. expired replies are warned and ignored; unknown replies are hard errors
9. disconnect rejects in-flight RPCs promptly
10. queued builder events are replayed after reconnect
11. `/builder build` activates planner-side supervision state immediately after handoff ack
12. outcome string is synthesized correctly from planner context
13. planner-side supervision analyzes `progress` as well as blocker/terminal events
14. planner-side steer is delivered to builder and visible in builder session
15. planner-side escalation surfaces to human when stagnation threshold is reached

---

## Decision summary

- repo-scoped paired planner/builder architecture
- builder-owned Unix socket with framed typed messages
- protocol v2: `request` / `reply` / `command` / `event`
- socket is the only interactive control plane; files are durability support, not a parallel message transport
- stable repo-scoped `pairId`, not planner-session identity
- same-planner reconnect takes over cleanly; different-planner gets busy error
- builder events queued to disk across planner disconnects
- `/builder build` is always supervised — no unsupervised delegation
- supervision is planner-owned; the builder does not run a second internal supervisor
- planner-side supervision uses direct model calls on the **current planner model**
- outcome string is synthesized from the handoff spec via cheap **Haiku** call — separate from planner analysis model by design
- escalation follows a planner-owned stagnation policy after repeated unsuccessful steering
- keeping supervision entirely on the planner preserves observability, attribution, and clean role separation
