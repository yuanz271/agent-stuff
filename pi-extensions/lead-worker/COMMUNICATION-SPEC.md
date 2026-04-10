# MAGIC DOC: Lead-Worker Communication Refactor Spec
*Focus on communication architecture, protocol semantics, and migration boundaries for the current repo-scoped lead-worker extension.*

## Summary

Refactor `pi-extensions/lead-worker` to use the communication component quality of the discarded socket-based lead-worker extension while keeping the **current repo-scoped paired lead/worker architecture**.

The old design's worker-side substrate was good:
- persistent repo-scoped worker
- tmux-backed process lifecycle
- low-latency request/reply IPC
- direct commands with explicit success/error replies
- unsolicited worker → lead notifications
- fail-fast protocol handling

The old design's problem was the **central lead architecture**, not the worker or socket transport:
- lead identity was durable and repo-bound
- lead switching depended on session/cwd rebinding
- changing cwd naturally became difficult or unsupported

That central-lead problem is no longer part of the current architecture. Therefore, this refactor should change the **communication component**, not the overall paired repo-local lead/worker structure.

## Scope

### In scope
- Replace the current internal mailbox-style lead↔worker message flow with a stricter paired IPC layer.
- Restore typed messages with explicit request/reply/command/event semantics.
- Preserve repo-local paired lead/worker behavior.
- Preserve tmux-backed worker lifecycle.
- Preserve current public branding and primary UX:
  - `/lead`
  - `/build`
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
- **Worker is the socket server**.
- **Lead is the socket client** for the current paired repo context.
- The socket is scoped to the pair runtime directory, not to a central lead identity.

### Socket location

Use a deterministic repo-local path inside the lead-worker runtime directory:

```text
<repo>/.pi/lead-worker/<pair-id>/protocol-v2/worker.sock
```

`pair-id` is a repo-scoped worker identity, not a lead-session identity.

### Pair ownership

A worker serves **one active lead connection at a time**.

Required policy:
- the first healthy lead connection owns the worker session
- a second lead connection is rejected with an explicit busy error
- ownership is released when the active connection closes or is declared dead

This refactor does not include shared multi-lead arbitration.

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
A valid `pairId` must:
- be stable for the repo-scoped worker runtime
- survive individual lead reconnects
- not depend on the current lead session id
- map deterministically to the runtime directory and socket path

Initial recommendation:
- derive `pairId` from resolved project root plus a fixed worker slot identifier
- keep it stable until the worker is explicitly reset or re-provisioned

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
7. message ownership matches the active lead connection

Any failure is a **protocol error**, not a warning.

## Request lifecycle

### Request path
1. sender allocates unique `id`
2. sender transmits `request`
3. sender records pending request with timeout
4. receiver handles the request
5. receiver emits one `reply`
6. sender resolves or rejects the pending request

### Timeout
- Blocking requests and commands must time out explicitly.
- Default timeout should remain aligned with the historical lead-worker expectation: **10 minutes**.
- On timeout:
  - reject the pending caller
  - mark the request closed as expired
  - a later reply for that expired id is surfaced visibly as a stale reply and ignored

Unknown replies for ids that were never issued remain protocol errors.

## Command model

Commands are operational control messages that execute directly on the target side and reply with explicit success/failure.

### Initial command set
At minimum, support commands equivalent to the useful old worker control surface:
- `status`
- `interrupt`
- `thinking`
- `model`

This command set may expand later, but each command must remain explicitly named and validated.

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
- readiness
- handoff started
- blocker
- clarification needed
- completion
- crash/restart notice (if detectable)

### Constraints
- Events must not block waiting for a reply.
- Events should still be validated like any other message.
- Completion events associated with `/build` should include `handoffId` whenever available.

## Public surface mapping

The public UX stays the same, but it should be reimplemented on top of the typed protocol.

### Tool
Extend `lead_worker(...)` with structured actions:
- existing control actions remain:
  - `start`
  - `on`
  - `status`
  - `off`
  - `stop`
- new communication actions:
  - `message` — send a one-way paired `event`
  - `ask` — send a blocking `request`
  - `command` — send a blocking `command`

### Slash commands
- `/lead` remains the main mode control command.
- `/build` becomes a protocol-backed delegated operation rather than an ad hoc mailbox drop.
- Worker control slash commands, if added later, must delegate to the same protocol layer rather than bypassing it.

## `/build` semantics under the new protocol

`/build` is a high-level wrapper on top of the communication layer.

### Required behavior
1. Gather recent lead context and explicit build instructions.
2. Construct a handoff payload that contains:
   - goal
   - relevant files
   - constraints
   - implementation steps
   - validation expectations
   - `handoffId`
3. Send the handoff to the worker using the typed protocol.
4. Track the handoff by `handoffId` until one terminal outcome is observed.

### Handoff event model
Allowed non-terminal events:
- `handoff_started`
- `blocker`
- `clarification_needed`
- `progress`

Required terminal event set:
- `completed`
- `failed`
- `cancelled`

Each handoff may emit zero or more non-terminal events and **exactly one** terminal event.

### Constraint carried forward from current design
The lead must send **intent/specification only**, not concrete code blocks or patches to paste blindly.

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

### Worker durability
- Worker process is durable and tmux-backed.
- Socket lifetime is tied to the live worker process.

### Lead reconnect behavior
- Lead may reconnect to the worker socket after a disconnect or runtime reload.
- Reconnection is a new transport connection, not a continuation of the old stream.
- In-flight blocking requests on the disconnected lead side must be rejected immediately.
- Reconnect does not change `pairId`; it only establishes a new active lead connection.

### Stale socket cleanup
- Stale socket files in the protocol v2 runtime path should be cleaned up when starting the worker server.
- Cleanup must surface unexpected filesystem failures rather than silently ignoring them.
- Old mailbox artifacts are not part of cleanup correctness; they are ignored by the new transport.

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

## Validation plan

Minimum validation before considering the refactor complete:

1. **Type-check** the extension entrypoint and communication module.
2. **Happy-path worker startup** creates the socket and accepts a lead connection.
3. **Blocking request/reply** succeeds end-to-end.
4. **Command success/error** is reported truthfully.
5. **Worker unsolicited event** reaches the lead visibly.
6. **Malformed message** causes visible protocol failure.
7. **Unexpected reply** causes visible protocol failure.
8. **Disconnect during in-flight request** rejects pending caller promptly.
9. **`/build` handoff** allows interim events and produces exactly one terminal event.
10. **Second lead attach attempt** is rejected cleanly while another lead owns the worker connection.
11. **Old mailbox artifacts present on disk** do not affect protocol v2 operation.

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
