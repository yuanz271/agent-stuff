# MAGIC DOC: Lead–Worker Spec
*Focus on architecture decisions, IPC design, and component responsibilities*

# Lead–Worker Architecture

## Overview

A multi-session Pi setup where a single **lead** session coordinates multiple persistent **worker** sessions, one per repository. The user communicates exclusively with the lead. Workers are isolated per repo and persist independently of the lead.

---

## Goals

1. Single point of interaction — user talks only to the lead
2. Full context isolation — no cross-contamination between repos or between lead and worker
3. Worker persistence — workers survive lead restarts
4. Deterministic recovery — lead can always reconnect to a running worker without discovery infrastructure

## Non-Goals

- Multi-user or multi-lead setups
- Network communication (same machine only)
- General-purpose N:N messaging (use pi-messenger for that)

---

## Roles

### Lead
- The single session the user interacts with
- Switches active repo on user request
- Delegates tasks to the active worker
- Surfaces results back to the user
- Never edits files or runs commands directly
- Stateless across restarts — all durable state is in the repo

### Worker
- One per repository, one-to-one with a repo path
- Persistent until explicitly killed by the user
- Does all hands-on work: reading, editing, running commands, debugging, testing
- Communicates with the lead via Unix socket
- Escalates blockers and reports completion via blocking requests

---

## File Layout

```
~/repoA/.pi/
├── lead.jsonl     — lead's Pi session for this repo
├── worker.jsonl   — worker's Pi session
└── worker.sock    — Unix socket (worker listens, lead connects)

~/repoB/.pi/
├── lead.jsonl
├── worker.jsonl
└── worker.sock
```

### Rules
- All `.pi/` contents are repo-scoped: deleted with the repo, not tracked in git
- Each repo must have `.pi/` in its `.gitignore`
- Lead working directory is irrelevant — all paths are resolved from the repo root
- `worker.sock` is created by the worker on startup and deleted on clean exit

---

## IPC Protocol

### Transport

Direct Unix socket at `<repo>/.pi/worker.sock`. No broker. The socket path is deterministic so both sides can find each other without discovery.

### Framing

Length-prefixed JSON:
```
[4-byte big-endian uint32 length][UTF-8 JSON payload]
```

### Message Schema

```ts
interface Message {
  id: string;          // UUID, unique per message
  type: "request" | "reply";
  replyTo?: string;    // set on replies: ID of the originating request
  payload: string;     // message body (task, status, question, answer)
}
```

### Message Patterns

| Pattern | Initiator | Blocking | Description |
|---------|-----------|----------|-------------|
| Task delegation | Lead | No | Lead sends task, continues without waiting |
| Status query | Lead | Yes | Lead asks worker for current state |
| Blocker escalation | Worker | Yes | Worker asks lead for clarification |
| Completion report | Worker | Yes | Worker reports task done, waits for next instruction |

**Blocking** calls: sender includes `id`, waits for a reply message with matching `replyTo` before returning. Timeout: 10 minutes.

---

## Lifecycle

### Switch to a repo

```
User: "switch to ~/repoA"

1. Lead tries to connect to ~/repoA/.pi/worker.sock
   a. Connection succeeds  → worker already running, proceed to step 3
   b. Connection fails     → worker not running, go to step 2

2. Spawn worker:
   - Start detached Pi process in ~/repoA with session file ~/repoA/.pi/worker.jsonl
   - Poll for ~/repoA/.pi/worker.sock (timeout: 10s, interval: 200ms)
   - Connect once socket appears

3. Load ~/repoA/.pi/lead.jsonl as the lead's active session

4. Send status query to worker, surface result to user
```

### Lead restart

```
1. Lead starts
2. Determine last active repo from most recent lead session file (scan ~/.pi/ or repo paths)
3. Try to connect to <active-repo>/.pi/worker.sock
   a. Success → reconnect, query status, surface to user
   b. Failure → notify user: "Worker for <repo> is not running. Spawn it?"
```

### Worker startup

```
1. Worker extension initialises
2. Creates and listens on <repo>/.pi/worker.sock
3. Accepts connections from lead
4. On clean shutdown: removes worker.sock
```

### Worker crash recovery

If `worker.sock` exists but connection is refused (stale socket from a crashed worker):
1. Lead detects connection refusal
2. Lead deletes stale `worker.sock`
3. Lead spawns fresh worker
4. Proceeds normally

---

## Context Isolation

| Session | Visible context |
|---------|-----------------|
| Worker (repoA) | Only tasks delegated to it; its own repo files and history |
| Worker (repoB) | Only tasks delegated to it; its own repo files and history |
| Lead (repoA session) | Only lead↔worker conversation for repoA |
| Lead (repoB session) | Only lead↔worker conversation for repoB |
| User | Only the lead's active session |

Lead never exposes one repo's context when working in another. Worker never sees the lead's planning conversation.

---

## Components

### Lead Extension (`pi-extensions/lead/index.ts`)

Responsibilities:
- `/switch <repo-path>` slash command
- Socket client: connect, send, receive, correlation ID tracking
- Spawn logic: start worker, wait for socket, handle stale socket
- Per-repo session loading on switch
- Surface worker replies to user

### Worker Extension (`pi-extensions/worker/index.ts`)

Responsibilities:
- Unix socket server: listen on `<repo>/.pi/worker.sock`
- Accept connection from lead
- Receive tasks, send replies
- Blocking request support (send question, wait for reply with `replyTo`)
- Clean socket removal on session shutdown

### Gitignore

Each repo must contain:
```
.pi/
```

---

## Resolved Design Questions

1. **Custom session file path** — `pi --session <path>` is supported. Worker is spawned as `pi --session <repo>/.pi/worker.jsonl` from the repo directory.

2. **Lead session switching** — `ctx.switchSession(sessionPath)` is exposed to extensions via the extension API. The lead switches to `<repo>/.pi/lead.jsonl` in-process on switch — no restart required.

3. **Simultaneous workers** — Deferred; single active worker is sufficient for v1.
