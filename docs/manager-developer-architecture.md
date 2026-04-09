# Manager–Developer Architecture

A multi-session Pi setup where a single **manager** session coordinates multiple persistent **developer** sessions, one per repository.

---

## Roles

### Manager
- The single session the user talks to
- Switches between repos on user request
- Delegates tasks to the active developer
- Surfaces results back to the user
- Never touches code directly
- Can be quit and restarted freely — all state is in the repo

### Developer
- One per repository, persistent until explicitly killed
- Does all the actual work: reading, editing, running commands, debugging, testing
- Reports back to the manager via pi-intercom
- Uses `ask` to escalate blockers or request clarification
- Accumulates working context in its own session

---

## Session Files

Each repo contains a paired set of session files:

```
~/repoA/.pi/
├── manager.jsonl    ← manager's planning session for this repo
└── developer.jsonl  ← developer's working session in this repo

~/repoB/.pi/
├── manager.jsonl
└── developer.jsonl
```

- Session files are repo-scoped — deleted with the repo
- Both files are gitignored (`.pi/` in each repo's `.gitignore`)
- Manager working directory is irrelevant — sessions are always resolved by repo path

---

## Communication

Uses **pi-intercom** for manager↔developer messaging:

| Pattern | Action | Direction |
|---------|--------|-----------|
| Task delegation | `send` | Manager → Developer |
| Status query | `ask` | Manager → Developer |
| Blocker escalation | `ask` | Developer → Manager |
| Completion report | `ask` | Developer → Manager |

`ask` is the key primitive — it sends and blocks until the recipient replies, returning the answer as a tool result in the same turn. The developer can continue working without losing context.

---

## Lifecycle

### Developer startup
```
User: "switch to ~/repoA"
  → Manager checks intercom list: developer for ~/repoA running?
  → No  → spawn detached pi in ~/repoA with developer.jsonl as session
  → Yes → skip spawn
  → Manager loads ~/repoA/.pi/manager.jsonl as its active session
  → Manager asks developer for current status
  → Ready
```

### Manager restart
```
Manager starts
  → Reads active repo from last session (~/repoA/.pi/manager.jsonl)
  → Checks intercom: developer still running?
  → Yes → reconnects, queries status
  → No  → notifies user, offers to respawn
```

### Developer persistence
- Developers run until explicitly killed by the user
- Manager quit does not affect developers
- Multiple developers can run simultaneously (one per repo)

---

## Context Isolation

| Layer | Sees |
|-------|------|
| Developer (repoA) | Only tasks delegated to it; its own repo context |
| Developer (repoB) | Only tasks delegated to it; its own repo context |
| Manager (repoA session) | Only planning history for repoA |
| Manager (repoB session) | Only planning history for repoB |
| User | Only the manager |

No cross-contamination between repos at any layer.

---

## Components Required

1. **pi-intercom** — worker discovery, spawn detection, `send`/`ask` messaging (license pending)
2. **Manager extension** — `/switch <path>` command, spawn logic, per-repo session loading
3. **`.gitignore` entry** — `.pi/` in each repo

---

## Open Questions

- Does Pi support specifying a custom session file path at startup? Required for spawning the developer with `developer.jsonl` and loading `manager.jsonl` on switch.
- How does the manager handle simultaneous delegation to multiple developers?
