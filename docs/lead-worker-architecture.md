# MAGIC DOC: Lead–Worker Architecture
*Focus on architecture decisions, IPC design, and component responsibilities*

# Lead–Worker Architecture

A multi-session Pi setup where a single **lead** session coordinates multiple persistent **worker** sessions, one per repository.

---

## Roles

### Lead
- The single session the user talks to
- Switches between repos on user request
- Delegates tasks to the active worker
- Surfaces results back to the user
- Never touches code directly
- Can be quit and restarted freely — all state is in the repo

### Worker
- One per repository, persistent until explicitly killed
- Does all the actual work: reading, editing, running commands, debugging, testing
- Reports back to the lead via direct Unix socket
- Uses the socket to escalate blockers or request clarification
- Accumulates working context in its own session

---

## Session Files

Each repo contains a paired set of session files and a socket:

```
~/repoA/.pi/
├── lead.jsonl     ← lead's planning session for this repo
├── worker.jsonl   ← worker's working session in this repo
└── worker.sock    ← Unix socket: worker listens, lead connects

~/repoB/.pi/
├── lead.jsonl
├── worker.jsonl
└── worker.sock
```

- All files are repo-scoped — deleted with the repo
- All files are gitignored (`.pi/` in each repo's `.gitignore`)
- Lead working directory is irrelevant — everything is resolved by repo path

---

## IPC: Direct Unix Socket

No broker. Lead and worker communicate directly via a Unix socket at a deterministic path.

**Why no broker:**
- Lead spawns the worker — socket path is known from birth (`<repo>/.pi/worker.sock`)
- On lead restart, socket path is still deterministic — lead tries to connect; success means worker is running, failure means it needs spawning
- The filesystem is the discovery mechanism

**Protocol:** length-prefixed JSON over Unix socket (4-byte length + JSON payload).

| Pattern | Direction | Blocking |
|---------|-----------|---------|
| Task delegation | Lead → Worker | No |
| Status query | Lead → Worker | Yes — waits for reply |
| Blocker escalation | Worker → Lead | Yes — waits for reply |
| Completion report | Worker → Lead | Yes — waits for reply |

Blocking calls send a message with a correlation ID and wait for a matching reply before returning the result to the caller.

---

## Lifecycle

### Switch to a repo
```
User: "switch to ~/repoA"
  → Lead tries to connect to ~/repoA/.pi/worker.sock
  → Success → worker already running, reconnect
  → Failure → spawn detached pi in ~/repoA with worker.jsonl as session
            → wait for worker.sock to appear
            → connect
  → Lead loads ~/repoA/.pi/lead.jsonl as its active session
  → Lead queries worker for current status
  → Ready
```

### Lead restart
```
Lead starts
  → Reads active repo from last session
  → Tries to connect to <active-repo>/.pi/worker.sock
  → Success → reconnect, query status
  → Failure → notify user, offer to respawn
```

### Worker lifecycle
- Worker listens on `<repo>/.pi/worker.sock` on start
- Runs until explicitly killed by the user
- Lead quit does not affect workers
- Socket cleaned up on worker exit
- Multiple workers can run simultaneously (one per repo)

---

## Context Isolation

| Layer | Sees |
|-------|------|
| Worker (repoA) | Only tasks delegated to it; its own repo context |
| Worker (repoB) | Only tasks delegated to it; its own repo context |
| Lead (repoA session) | Only planning history for repoA |
| Lead (repoB session) | Only planning history for repoB |
| User | Only the lead |

No cross-contamination between repos at any layer.

---

## Components Required

1. **Lead extension** — `/switch <path>` command, spawn logic, socket client, per-repo session loading
2. **Worker extension** — Unix socket server, message handler, reply mechanism
3. **`.gitignore` entry** — `.pi/` in each repo

---

## Open Questions

- Does Pi support specifying a custom session file path at startup? Required for spawning the worker with `worker.jsonl` and loading `lead.jsonl` on switch.
- How does the lead handle simultaneous delegation to multiple workers?
