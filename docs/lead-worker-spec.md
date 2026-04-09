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

1. Resolve and validate path:
   - If ~/repoA does not exist → report error, do nothing

2. Call ctx.switchSession(path.resolve('~/repoA/.pi/lead.jsonl'))
   - Resumes existing session if lead.jsonl exists (full history restored)
   - Creates a fresh session if lead.jsonl does not exist (first activation for this repo)
   - Updates lead's cwd to ~/repoA

3. Try to connect to ~/repoA/.pi/worker.sock
   a. Connection succeeds → worker already running, proceed to step 4
   b. Connection fails    → worker not running, go to spawn

   Spawn worker:
   - repoPath = path.resolve(expandTilde('~/repoA'))  // ~ must be expanded before path.resolve
   - spawn('pi', ['--session', repoPath + '/.pi/worker.jsonl'], { cwd: repoPath, detached: true, stdio: 'ignore' }).unref()
   - Poll for worker.sock (timeout: 10s, interval: 200ms)
   - Connect once socket appears

4. Query worker status, surface to user
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

**On activation** (`/lead <path>`): if `worker.sock` exists but connection is refused (stale socket):
1. Lead deletes stale `worker.sock`
2. Spawns fresh worker
3. Proceeds normally

**During active lead mode**: lead's socket `close` event fires unexpectedly (not lead-initiated):
1. Lead detects unexpected close (lead did not call `socket.destroy()`)
2. Notifies user: "Worker crashed, respawning..."
3. Deletes stale `worker.sock`
4. Spawns fresh worker, reconnects
5. Resumes — no `/lead` command required

---

## Connection State

### Worker socket server

The worker runs a persistent `net.createServer` that accepts multiple sequential connections — one lead connection at a time. When the lead disconnects, the server continues listening for the next connection.

### Lead disconnect

When the lead switches repos or exits, it closes the socket. The worker detects the `close` event and enters **disconnected state**:
- No new unsolicited messages are sent (they would be lost)
- Any in-flight blocking call waiting for a lead reply is immediately rejected with an error (do not wait for the 10-minute timeout)
- Worker resumes normal operation, waiting for the lead to reconnect

### Lead reconnect

When `/lead <repo>` is run again for a repo with a running worker:
- Worker accepts the new connection
- Lead queries status to re-orient
- Messages sent while the lead was away are not replayed — they are lost. Worker should treat reconnect as a fresh coordination point.

### In-flight calls on disconnect

| Scenario | Behaviour |
|----------|-----------|
| Lead waiting for worker reply, lead disconnects | N/A — lead initiated, lead controls timeout |
| Worker waiting for lead reply, lead disconnects | Worker's pending call errors immediately on socket `close` |
| Lead waiting for worker reply, worker crashes | Lead's pending call errors on socket `close`; lead notifies user |
| Worker crashes during active lead mode | Lead detects unexpected socket close, auto-respawns worker, reconnects |

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
- `/lead <repo-path>` slash command
- Socket client: connect, send, receive, correlation ID tracking
- Persistent `data` listener on socket — incoming worker messages call `pi.sendMessage({ triggerTurn: true })` to inject them into the lead's conversation
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

2. **Path validation** — `/lead <path>` reports an error and does nothing if the path does not exist. `ctx.switchSession` is never called with an invalid path.

3. **Tilde expansion** — `~` must be expanded to `os.homedir()` before calling `path.resolve` — Node.js `path.resolve` does not expand tildes.

4. **First-ever activation** — `ctx.switchSession` on a non-existent `lead.jsonl` creates a fresh session. All subsequent activations resume from the existing file.

5. **Lead session switching** — `ctx.switchSession(absolutePath)` loads the session in-process, restores full history, and updates `cwd`. No Pi restart required.

6. **Worker session** — `pi --session <path>` also creates the file if absent. New worker starts with a blank session.

7. **Blocking timeout** — Both sides enforce a 10-minute timeout on blocking calls. On timeout, the blocked call errors and the caller surfaces the failure (lead notifies user; worker reports error and may retry or abort the task).

8. **Simultaneous workers** — Deferred; single active worker is sufficient for v1.
