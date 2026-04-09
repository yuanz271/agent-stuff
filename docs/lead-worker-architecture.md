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
- Reports back to the lead via pi-intercom
- Uses `ask` to escalate blockers or request clarification
- Accumulates working context in its own session

---

## Session Files

Each repo contains a paired set of session files:

```
~/repoA/.pi/
├── lead.jsonl    ← lead's planning session for this repo
└── worker.jsonl  ← worker's working session in this repo

~/repoB/.pi/
├── lead.jsonl
└── worker.jsonl
```

- Session files are repo-scoped — deleted with the repo
- Both files are gitignored (`.pi/` in each repo's `.gitignore`)
- Lead working directory is irrelevant — sessions are always resolved by repo path

---

## Communication

Uses **pi-intercom** for lead↔worker messaging:

| Pattern | Action | Direction |
|---------|--------|-----------|
| Task delegation | `send` | Lead → Worker |
| Status query | `ask` | Lead → Worker |
| Blocker escalation | `ask` | Worker → Lead |
| Completion report | `ask` | Worker → Lead |

`ask` is the key primitive — it sends and blocks until the recipient replies, returning the answer as a tool result in the same turn. The worker can continue working without losing context.

---

## Lifecycle

### Worker startup
```
User: "switch to ~/repoA"
  → Lead checks intercom list: worker for ~/repoA running?
  → No  → spawn detached pi in ~/repoA with worker.jsonl as session
  → Yes → skip spawn
  → Lead loads ~/repoA/.pi/lead.jsonl as its active session
  → Lead asks worker for current status
  → Ready
```

### Lead restart
```
Lead starts
  → Reads active repo from last session (~/repoA/.pi/lead.jsonl)
  → Checks intercom: worker still running?
  → Yes → reconnects, queries status
  → No  → notifies user, offers to respawn
```

### Worker persistence
- Workers run until explicitly killed by the user
- Lead quit does not affect workers
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

1. **pi-intercom** — worker discovery, spawn detection, `send`/`ask` messaging (license pending)
2. **Lead extension** — `/switch <path>` command, spawn logic, per-repo session loading
3. **`.gitignore` entry** — `.pi/` in each repo

---

## Open Questions

- Does Pi support specifying a custom session file path at startup? Required for spawning the worker with `worker.jsonl` and loading `lead.jsonl` on switch.
- How does the lead handle simultaneous delegation to multiple workers?
