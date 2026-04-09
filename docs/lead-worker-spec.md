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
- A regular Pi session until the user activates it with `/lead <repo-path>`
- On activation: loads the repo's lead session and connects to (or spawns) its worker
- Delegates tasks to the active worker
- Surfaces results back to the user
- Never edits files or runs commands directly
- Lead mode is per-activation — no special startup required

### Worker
- One per repository, one-to-one with a repo path
- Spawned by the lead on first switch; persists until explicitly killed
- Unexpected exits are safe — session file preserves all state and the lead respawns on reconnect
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

The socket is a persistent bidirectional connection — both lead and worker can initiate messages at any time. Lead initiates as client; worker can send unsolicited messages (escalations, completion reports) back on the same connection.

---

## Lifecycle

### Activate lead mode

```
User runs: /lead ~/repoA

1. Call ctx.switchSession(path.resolve('~/repoA/.pi/lead.jsonl'))
   - Creates session file if it doesn't exist (new repo)
   - Loads full conversation history if it does (resume)
   - Updates lead's cwd to ~/repoA

2. Try to connect to ~/repoA/.pi/worker.sock
   a. Connection succeeds → worker already running, proceed to step 3
   b. Connection fails    → worker not running, go to spawn

   Spawn worker:
   - resolve path: repoPath = path.resolve('~/repoA')
   - spawn('pi', ['--session', repoPath + '/.pi/worker.jsonl'], { cwd: repoPath, detached: true, stdio: 'ignore' }).unref()
   - Poll for worker.sock (timeout: 10s, interval: 200ms)
   - Connect once socket appears

3. Query worker status, surface to user
```

### Switch to another repo

```
User runs: /lead ~/repoB
  → Same flow as activation above
  → Previous worker connection is closed (worker keeps running)
```

### Lead restart

```
1. pi starts normally
2. User runs /lead ~/repoA to resume
3. ctx.switchSession loads ~/repoA/.pi/lead.jsonl (full history restored)
4. Lead connects to worker (or spawns if not running)
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

1. **Lead activation** — `/lead <path>` slash command activates lead mode. No special Pi startup needed; lead is a regular Pi session until activated.

2. **Worker spawn path** — `pi --session <path>` supported. Paths must be fully resolved (`path.resolve`) before passing to `spawn` — shell tilde expansion does not apply.

3. **First-ever activation** — `ctx.switchSession` on a non-existent file creates a fresh session. New repos get a blank `lead.jsonl` automatically.

4. **Lead session switching** — `ctx.switchSession(absolutePath)` loads the session in-process, restores full history, and updates `cwd`. No Pi restart required.

5. **Worker session** — `pi --session <path>` also creates the file if absent. New worker starts with a blank session.

6. **Simultaneous workers** — Deferred; single active worker is sufficient for v1.
