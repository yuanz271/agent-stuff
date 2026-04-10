# Lead-Worker Communication Spec
*Communication architecture, protocol semantics, and migration boundaries for the current repo-scoped lead-worker extension.*

## Summary

`lead-worker` keeps the current repo-scoped paired architecture and replaces the old mailbox transport with a worker-owned socket protocol.

Why:
- the old worker model was good: persistent tmux-backed worker, low-latency request/reply, truthful command acks, direct worker → lead events
- the old failure was the central lead architecture, not the worker or socket
- the current design already removed the central lead problem, so only the communication component needed replacement

## Scope

### In scope
- Replace the current internal mailbox-style lead↔worker message flow with a stricter paired IPC layer.
- Restore typed messages with explicit request/reply/command/event semantics.
- Preserve repo-local paired lead/worker behavior.
- Preserve tmux-backed worker lifecycle.
- Preserve current public branding and primary UX:
  - `/lead`
  - `/worker status`
  - `/worker build`
  - `lead_worker(...)`
- Enforce fail-fast protocol behavior for malformed or unexpected messages.

### Out of scope
- Reintroducing a central cross-repo lead session.
- Reintroducing `ctx.switchSession(...)`-driven lead session hopping.
- Rebinding lead identity to repo-local durable lead session files.
- Copying any code from `pi-intercom` or other unlicensed sources.
- Broad workflow redesign beyond communication and its immediate integration points.

## Design constraints

1. **Repo-scoped pairing remains the architectural unit**
   - A lead/worker pair belongs to one repo/runtime context.
   - Communication changes must not bring back a single durable global lead.

2. **Worker remains the durable endpoint**
   - Worker runtime is tmux-backed and durable across individual lead turns.
   - Lead runtime may restart or reload without corrupting protocol state.

3. **Communication must be explicit and typed**
   - Best-effort string drops are insufficient.
   - Blocking calls must have tracked replies.

4. **Protocol failures must be visible**
   - Malformed frames/messages, unexpected replies, and invalid correlation are hard errors.
   - Do not silently swallow protocol corruption.

5. **No source reuse from unlicensed repos**
   - This is a clean-room reimplementation inspired by earlier local work and observed behavior only.

## Recommended transport

Use a **repo-local Unix domain socket** owned by the worker.

### Rationale
- The old worker-side socket behavior was the useful part worth recovering.
- Socket IPC gives low-latency request/reply semantics and truthful command acknowledgments.
- The prior socket failure mode came from the central lead architecture, not from the socket itself.
- With the current repo-scoped paired model, the socket can be treated as a local communication component rather than a global coordination primitive.

### Ownership model
- **worker** owns the socket server
- **lead** is a client of the repo-local worker
- one worker allows **one active lead session** at a time
- a different lead session gets an explicit busy error
- same-lead reconnect must replace the stale socket instead of tripping busy
- ownership is released on socket `close` / `error`; no heartbeat in v2

### Socket location

```text
<repo>/.pi/lead-worker/<pair-id>/protocol-v2/worker.sock
```

`pair-id` is repo-scoped worker identity, not lead-session identity.

## Protocol model

### Roles
- `lead`
- `worker`

### Message types
- `request` — blocking question expecting exactly one reply
- `reply` — response to a `request` or `command`
- `command` — imperative operational instruction expecting exactly one reply
- `event` — unsolicited notification with no reply expected

### Canonical message schema

```ts
type PairMessageV2 = {
  version: 2;
  id: string;
  type: "request" | "reply" | "command" | "event";
  from: "lead" | "worker";
  to: "lead" | "worker";
  pairId: string;
  timestamp: string; // ISO 8601
  name?: string;     // required for command and event
  body?: string;     // human-readable text
  payload?: unknown; // structured message-specific data
  replyTo?: string;  // required for reply
  ok?: boolean;      // required for reply
  error?: string;
  handoffId?: string;
};
```

## Protocol invariants

1. Every `request` must receive **exactly one** `reply`.
2. Every `command` must receive **exactly one** `reply`.
3. `reply.replyTo` must reference one known in-flight `request` or `command`.
4. `event` messages must not expect replies.
5. `from`, `to`, and `pairId` must match the active pair context.
6. `command` and `event` messages must set `name`.
7. `reply` messages must set `replyTo` and `ok`.
8. Unknown `type` or missing required fields are protocol errors.
9. Malformed messages are connection-fatal for the current socket.

## Pair identity

The protocol uses an explicit `pairId` rather than any lead-session identifier.

### Why
- Communication is a component of a repo-scoped pair, not of a central global lead.
- The worker is the durable endpoint; the lead is a transient client.
- A repo-local worker must remain addressable across lead reconnects and runtime reloads.

### Pair identity requirements
`pairId` must:
- be stable for the repo-scoped worker runtime
- survive lead reconnects
- not depend on lead session id
- map deterministically to runtime paths

Current rule:
- `pairId = sha256(realpath(projectRoot) + ":default")`
- full hash is protocol identity; filesystem paths and runtime labels may use a short prefix

## Framing and validation

### Framing
Use explicit socket framing, not newline-delimited best effort parsing.

Recommended approach:
- 4-byte big-endian length prefix
- UTF-8 JSON payload

### Validation
On receipt, validate in order:
1. frame length is sane and within max bound
2. payload is valid JSON
3. payload matches `PairMessageV2`
4. role and destination are valid for the receiving endpoint
5. `name`, `replyTo`, and `ok` are present exactly when required
6. `pairId` matches the active runtime
7. message ownership matches the active lead session

Any failure is a **protocol error**, not a warning.

## Request lifecycle

- sender allocates `id`, sends request/command, and records one pending RPC
- receiver emits exactly one reply
- default timeout: **10 minutes**
- timeout expires the RPC locally; a later reply becomes a visible stale reply and is ignored
- a reply for an id that was never issued is a protocol error

## Command model

Commands are operational control messages that execute directly on the target side and reply with explicit success/failure.

### Command set
Current worker commands:
- `status`
- `interrupt`
- `thinking`
- `model`
- `handoff`
- `slash_command`

Why they exist:
- `handoff` is the structured delegation primitive
- `slash_command` is an optional escape hatch, not a core abstraction; it exists only to reuse worker-local slash commands without growing the protocol surface

### Command reply shape
A successful command reply should set:
- `type: "reply"`
- `ok: true`
- `replyTo: <command-id>`

A failed command reply should set:
- `type: "reply"`
- `ok: false`
- `replyTo: <command-id>`
- `error: <human-readable explanation>`

## Event model

Events are unsolicited notifications emitted by either side, though worker → lead events are the primary use case.

### Important worker events
- `readiness`
- `progress`
- `blocker`
- `clarification_needed`
- terminal updates: `completed` / `failed` / `cancelled`
- `busy` for rejected second-lead attachment

Events never wait for replies. Worker-build-related events carry `handoffId` when available.

## Public surface mapping

The public UX stays the same, but it should be reimplemented on top of the typed protocol.

### Tool
`lead_worker(...)` exposes:
- control: `start`, `on`, `status`, `off`, `stop`
- communication: `message`, `ask`, `command`, `reply`

Policy:
- `ask` / `command` / `/worker build` auto-start the worker if needed
- `message` requires an already-available worker connection

### Slash commands
- `/lead` remains the mode control command.
- `/worker status` is the direct worker status view.
- `/worker build` is the high-level delegation wrapper.
- `/worker /<command>` remains the escape hatch for worker-local slash commands that are not worth promoting into first-class protocol commands

## `/worker` subcommands

### `/worker status`
Direct status query over protocol v2. This exists so the lead can inspect worker state without packaging a task handoff.

### `/worker build`
High-level delegation wrapper over the lower-level `handoff` command.

Behind the scenes it:
- gathers recent lead context
- adds explicit build instructions from the command line
- packages a spec-oriented handoff with `handoffId`
- sends one typed `handoff` command to the worker

Rules:
- the lead sends **intent/spec only**, never copy-paste implementation blocks
- a handoff may emit interim events (`progress`, `blocker`, `clarification_needed`)
- a handoff must emit exactly one terminal event: `completed`, `failed`, or `cancelled`
- once the worker accepts the handoff, execution is worker-owned; lead disconnect only loses observation, not execution

### Optional command forwarding
`slash_command` exists to preserve coverage without forcing the lead protocol to mirror every useful worker-local slash command. Keep it as an escape hatch; add explicit `/worker <subcommand>` aliases only for high-value frequent operations.

## Error semantics

### Hard errors
Treat these as connection-fatal protocol errors:
- invalid length prefix
- oversized frame
- invalid JSON
- schema mismatch
- invalid `from`/`to`
- invalid active-lead ownership
- reply without valid `replyTo`
- unexpected reply to an id that was never issued
- wrong `pairId`
- duplicate resolution of the same request

### Recoverable operational errors
These should return explicit error replies rather than corrupting the connection:
- unknown command name
- ambiguous model reference
- unavailable model/auth
- worker refused operation due to runtime state

## State and recovery

- worker is durable and tmux-backed; socket lifetime follows the live worker process
- compact lead status should expose logical state, not full tmux runtime labels
- tmux session naming should reuse the same pair-derived identity prefix rather than introducing a second unrelated hash
- lead reconnect is a new transport connection to the same `pairId`
- reconnect from the **same lead session** must take over the worker connection cleanly
- reconnect from a **different lead session** must get a busy error unless ownership is explicitly released
- in-flight RPCs on a disconnected lead fail immediately
- stale `worker.sock` in protocol-v2 path is cleaned on worker startup
- old mailbox artifacts are ignored by design

## Migration plan

### Version boundary
This refactor is a **clean protocol break**.

Backward compatibility is explicitly **not** a priority.

Do not implement:
- a compatibility shim for the current mailbox message format
- dual transport support
- fallback from socket protocol v2 to mailbox behavior
- identity rules preserved only for old runtime artifact compatibility

### Migration rule
- Introduce one communication implementation: **protocol v2 over the worker-owned socket**.
- Do not read old mailbox payloads as if they were v2 messages.
- Do not route new traffic through old mailbox files.
- Old communication artifacts may remain on disk, but the new implementation treats them as non-authoritative.

### Runtime directory recommendation
Use a versioned subpath for the new communication substrate:

```text
<repo>/.pi/lead-worker/<pair-id>/protocol-v2/
```

The versioned path is the only authoritative location for the new transport.

## Validation

Required checks:
1. type-check entrypoint + protocol module
2. worker startup creates socket and accepts one lead
3. same-lead reconnect replaces stale ownership cleanly
4. different-lead attach is rejected cleanly
5. blocking `ask` / `command` round-trips succeed
6. command success/error replies are truthful
7. unsolicited worker events surface visibly on lead
8. malformed frames/messages fail loudly
9. unknown replies fail loudly; expired replies are warned and ignored
10. disconnect rejects in-flight RPCs promptly
11. `/worker build` blocker and success paths both propagate with correct `handoffId`
12. old mailbox artifacts do not affect v2

## Non-goals and future work

### Not required in this refactor
- multi-lead arbitration beyond single-active-lead rejection
- cross-repo orchestration from one central control session
- brokered multiplexing across multiple workers
- message persistence across worker crashes beyond what tmux/session files already provide

### Possible future work
- explicit attach/detach semantics if the pair model later evolves
- narrower typed payload schemas per command/event name
- multi-worker fan-out from a single current session

## Decision summary

- Keep the **current repo-scoped paired lead/worker architecture**.
- Recover the **old worker-grade communication component**.
- Use a **worker-owned Unix socket** with explicit framed messages.
- Introduce **protocol v2** with `request` / `reply` / `command` / `event` and stable repo-scoped `pairId`.
- Make a clean cutover: no mailbox compatibility shim, no dual transport path.
- Treat protocol corruption as **hard failure**.
- Do **not** reintroduce the old central lead architecture.
- Do **not** copy `pi-intercom` code.
