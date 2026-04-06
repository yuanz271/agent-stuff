# Memory Extension — Specification

## Overview

A Pi extension that gives the agent **bounded, file-backed persistent memory** across sessions. Two stores — `MEMORY.md` (agent's notes) and `USER.md` (user profile) — are injected into the system prompt as a frozen snapshot and managed via a registered tool.

Modeled after the Hermes Agent memory system. Adapted to the Pi extension API surface.

---

## Goals

1. Agent remembers environment facts, user preferences, and lessons learned across sessions.
2. Memory is always visible in the system prompt (no explicit read needed).
3. Mid-session writes persist immediately to disk but do not change the system prompt (prefix cache stability).
4. Agent manages its own memory proactively via a tool.
5. Memory is bounded to prevent system prompt bloat.
6. Content is scanned for injection/exfiltration before acceptance.

## Non-Goals

- Session search / transcript recall (requires SQLite, out of scope for core).
- External memory providers (plugin system, out of scope for core).
- Background review / autonomous nudging (requires auxiliary LLM call).
- Pre-compression memory flush (requires auxiliary LLM call).
- Skill/procedural memory (separate concern).

---

## Storage

### Location

```
~/.pi/agent/memories/
├── MEMORY.md
└── USER.md
```

Profile-scoped, global (shared across all sessions). Created on first load if missing.

### Entry Format

Entries are delimited by `\n§\n` (newline + section sign + newline). Each entry is free-form text, may be multiline. Leading/trailing whitespace per entry is trimmed on read.

Example `MEMORY.md`:
```
User runs macOS 14, Homebrew, Docker Desktop. Shell: zsh.
§
Project ~/code/api uses Go 1.22, sqlc, chi router. Tests: make test.
§
Don't use sudo for Docker — user is in docker group.
```

### Character Limits

| Store | Default Limit | Approximate Tokens |
|-------|--------------|-------------------|
| `memory` | 2,200 chars | ~800 |
| `user` | 1,375 chars | ~500 |

Character count = `entries.join("\n§\n").length`. Limits are enforced on mutation; loads always succeed regardless of size.

---

## Frozen Snapshot Pattern

### Invariant

The system prompt injection is captured **once** when the store loads from disk and **never changes** during the session, even if the agent mutates memory via the tool.

### Rationale

- Preserves LLM prefix cache (stable prompt prefix → cache hits → lower cost).
- Tool responses always show **live** state so the agent sees its changes.
- New sessions pick up the latest state on next load.

### Lifecycle

```
session_start(any reason)
  → store.loadFromDisk()
  → snapshot captured (frozen for this session)

before_agent_start
  → append snapshot to event.systemPrompt
  → return modified systemPrompt

session_before_compact
  → store.loadFromDisk()
  → snapshot refreshed before compaction rebuilds the prompt

Tool call: memory(add/replace/remove)
  → disk updated immediately
  → snapshot unchanged
  → tool response shows live entries + usage
```

---

## System Prompt Injection

### Format

Appended to the end of the system prompt via `before_agent_start`. Each non-empty store renders as:

```
══════════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════════
Entry one text here
§
Entry two text here
```

```
══════════════════════════════════════════════════
USER PROFILE (who the user is) [45% — 619/1,375 chars]
══════════════════════════════════════════════════
User name, preferences, etc.
```

Empty stores are omitted entirely (no header, no empty block).

### Ordering

Memory block first, then user profile block. Both after the base system prompt.

---

## Memory Tool

### Registration

Registered via `pi.registerTool()`. Name: `memory`.

### Schema

```
Parameters:
  action:   "add" | "replace" | "remove"   (required)
  target:   "memory" | "user"              (required)
  content:  string                          (required for add, replace)
  old_text: string                          (required for replace, remove)
```

### Tool Description

The tool description instructs the agent on:
- **When to save** (proactively): user corrections, preferences, environment facts, conventions, lessons learned.
- **Priority**: user preferences/corrections > environment facts > procedural knowledge.
- **What to skip**: trivial info, easily re-discovered facts, raw data dumps, session-specific ephemera.
- **Two targets**: `memory` (agent's notes) vs `user` (user profile).
- **Capacity awareness**: usage % is visible; consolidate when above 80%.

### Prompt Guidelines

Registered via `promptGuidelines` on the tool definition:
- Proactively save user preferences, environment facts, and lessons learned.
- Consolidate entries when memory is above 80% capacity.
- Do not save task progress, session-specific ephemera, or easily re-discovered facts.

### Actions

#### `add`

1. Validate: `content` is required and non-empty.
2. Security scan `content`. Reject if blocked.
3. Reload entries from disk (pick up concurrent writes).
4. Reject if `content` is an exact duplicate of an existing entry.
5. Compute projected char count. Reject if over limit with error showing current usage.
6. Append entry to list.
7. Write to disk (atomic).
8. Return success response with live entries + usage.

#### `replace`

1. Validate: `old_text` and `content` are required and non-empty.
2. Security scan `content`. Reject if blocked.
3. Reload entries from disk.
4. Find entries containing `old_text` as substring.
5. If 0 matches → error "No entry matched".
6. If >1 matches with distinct text → error "Multiple entries matched, be more specific" + previews.
7. If >1 matches but all identical text → operate on first (safe dedup).
8. Compute projected char count with replacement. Reject if over limit.
9. Replace entry at matched index.
10. Write to disk (atomic).
11. Return success response.

#### `remove`

1. Validate: `old_text` is required and non-empty.
2. Reload entries from disk.
3. Find entries containing `old_text` as substring.
4. If 0 matches → error.
5. If >1 matches with distinct text → error + previews.
6. If >1 matches but identical → remove first.
7. Remove entry.
8. Write to disk (atomic).
9. Return success response.

### Response Format

Success:
```json
{
  "success": true,
  "target": "memory",
  "entries": ["entry1", "entry2"],
  "usage": "67% — 1,474/2,200 chars",
  "entry_count": 2,
  "message": "Entry added."
}
```

Failure:
```json
{
  "success": false,
  "error": "Memory at 2,100/2,200 chars. Adding this entry (250 chars) would exceed the limit. Replace or remove existing entries first.",
  "entries": ["entry1", "..."],
  "usage": "95% — 2,100/2,200 chars"
}
```

Ambiguous match failure includes previews:
```json
{
  "success": false,
  "error": "Multiple entries matched 'docker'. Be more specific.",
  "matches": ["Don't use sudo for Docker — user is in do...", "Docker Desktop runs on port 2375 with TLS..."]
}
```

The tool result is returned as a single text block containing the JSON.

---

## File I/O

### Read

```
1. If file does not exist → return []
2. Read file as UTF-8
3. Split by "\n§\n"
4. Trim each entry, filter out empty strings
5. Deduplicate (preserve order, keep first occurrence)
```

No locking needed on read — atomic writes guarantee readers always see a complete file.

Missing-file reads (`ENOENT`) are treated as empty state. All other read failures propagate and fail the operation rather than silently degrading to an empty store.

### Write (Atomic)

```
1. Join entries with "\n§\n"
2. Write to temp file in same directory (.tmp.{random hex})
3. fsync / flush
4. Rename temp → target (atomic on same filesystem)
5. On failure: unlink temp file
```

### Mutation Lock

All mutations (add/replace/remove) are serialized by an in-process async lock (Promise chain). This prevents interleaved reload-modify-write sequences within the same Pi process.

Cross-process safety (multiple Pi instances) is not guaranteed. This is acceptable because:
- CLI usage is single-instance.
- The atomic rename prevents corruption even under races — worst case is a lost write, not data corruption.

---

## Content Security Scanning

### Threat Patterns

Scanned on every `add` and `replace` (the `content` parameter). Not scanned on `remove`.

| Pattern | ID |
|---------|----|
| `ignore (previous\|all\|above) instructions` | `prompt_injection` |
| `you are now ` | `role_hijack` |
| `do not tell the user` | `deception_hide` |
| `system prompt override` | `sys_prompt_override` |
| `disregard (your\|all\|any) (instructions\|rules)` | `disregard_rules` |
| `curl ... $(KEY\|TOKEN\|SECRET)` | `exfil_curl` |
| `wget ... $(KEY\|TOKEN\|SECRET)` | `exfil_wget` |
| `cat ... (.env\|credentials\|.netrc)` | `read_secrets` |
| `authorized_keys` | `ssh_backdoor` |
| `$HOME/.ssh` | `ssh_access` |

All patterns are case-insensitive.

### Invisible Characters

Block content containing any of: `\u200b`, `\u200c`, `\u200d`, `\u2060`, `\ufeff`, `\u202a`–`\u202e`.

### Behavior

If scan detects a threat → return `{ success: false, error: "Blocked: ..." }`. Entry is never written.

---

## Extension Lifecycle

### Events Handled

| Event | Action |
|-------|--------|
| `session_start` (any reason) | `store.loadFromDisk()` — reload entries, recapture snapshot |
| `before_agent_start` | Append frozen snapshot to `event.systemPrompt`; return modified prompt |
| `session_before_compact` | `store.loadFromDisk()` — refresh snapshot before compaction rebuilds the prompt |

### Initialization

On extension load (module-level):
1. Resolve storage directory: `~/.pi/agent/memories/`
2. Create `MemoryStore` instance (does not touch disk yet).
3. Register event handlers and tool.

Disk I/O happens only on `session_start`, not at import time.

---

## File Structure

```
pi-extensions/memory/
├── index.ts      Extension entry point
│                 - session_start handler (load)
│                 - before_agent_start handler (inject)
│                 - session_before_compact handler (refresh)
│                 - registerTool("memory", ...)
│
├── store.ts      MemoryStore class
│                 - loadFromDisk()
│                 - getSnapshotBlock(): string
│                 - add(target, content): MutationResult
│                 - replace(target, oldText, newContent): MutationResult
│                 - remove(target, oldText): MutationResult
│                 - (private) readFile, writeFileAtomic, renderBlock
│
└── scanner.ts    Content security
                  - scanContent(text): string | null
                    Returns error message if blocked, null if clean
```

### Dependencies

- Node.js built-ins only: `fs/promises`, `path`, `os`, `crypto`.
- Pi extension API: `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`.
- TypeBox: `@sinclair/typebox` (for tool parameter schema).
- No external npm packages.

---

## Behavioral Invariants

1. **Snapshot immutability**: `getSnapshotBlock()` returns the same string for the entire session until the next `loadFromDisk()` call.
2. **Live tool responses**: every mutation response reflects the current disk state, not the frozen snapshot.
3. **Reload before mutate**: every mutation reloads from disk before modifying, picking up writes from background processes or other sessions.
4. **Atomic writes**: readers never see partial file content.
5. **Bounded**: mutations that would exceed the char limit are rejected with an actionable error.
6. **Deduplicated**: exact duplicate entries are rejected on `add`; duplicate entries on disk are collapsed on load.
7. **Security-scanned**: content matching threat patterns or containing invisible characters is never written.

---

## Future Extensions (Out of Scope)

These are **not** part of the core spec but inform the design (interfaces should not preclude them):

- **Status widget**: show memory usage in footer via `ctx.ui.setStatus()`.
- **Background review**: spawn auxiliary LLM call every N turns to review conversation and save memories.
- **Pre-compression flush**: before `session_before_compact`, make one LLM call with only the memory tool to save important context.
- **External providers**: pluggable memory backends (Honcho, Mem0, etc.) via a provider interface.
- **Session search**: SQLite FTS5 over past conversations.
- **Configurable limits**: allow char limits to be set via extension config file.

The `MemoryStore` class should be importable by other extensions (e.g., a future review/nudge extension) without coupling to the tool registration.
