# MAGIC DOC: Magic Docs Autoupdate Spec
*Focus on automatic update triggering, detached updater architecture, and result/reporting boundaries for the magic-docs extension.*

## Goal

Restore automatic magic-doc updates without injecting maintenance turns into the main agent conversation.

## Summary

`magic-docs` splits into:
- **foreground coordinator** — track session-local magic docs, decide when to update, launch updater, report one-line result
- **background updater** — run a separate one-shot Pi session that re-reads and updates the tracked docs, then exits

Why:
- the old auto-trigger policy was useful
- the old execution path polluted the main agent context
- this feature needs a detached maintenance job, not a general subagent framework

## Scope

### In scope
- tracking magic docs from this session's `read` / `write` / `edit` results
- restoring idle-triggered autoupdate
- detached updater execution outside the main agent context
- one active updater job at a time
- one-line completion/failure reporting
- per-doc race protection

### Out of scope
- importing a subagent extension
- generic background-agent infrastructure
- repo-wide markdown scanning beyond docs already tracked in the current session
- streaming updater chatter into the main conversation

## Trigger policy

Autoupdate fires only when:
- tracked docs exist
- the main agent has been idle long enough
- cooldown has elapsed
- no updater job is already running

Recommended rule:
- reset idle counter after a tool-active run
- increment on idle `agent_end`
- launch when:
  - `trackedDocs.size > 0`
  - `consecutiveIdleRuns >= 2`
  - `now - lastLaunchAt >= 5 minutes`
  - no active lock

A lightweight model check may still decide whether an update is worthwhile, but it must not trigger a main-session rewrite turn.

## Architecture

### Foreground coordinator
Responsibilities:
- detect and restore tracked docs
- maintain idle counters and cooldown
- build a fixed update snapshot
- launch a detached updater job
- observe completion and emit one terse result line

### Background updater
Responsibilities:
- load the snapshot
- re-read each target doc from disk
- update only the listed docs
- skip docs that changed after snapshot
- write a result artifact and exit

## Runtime artifacts

Use a repo-local runtime directory:

```text
<repo>/.pi/magic-docs/
```

Suggested contents:

```text
state.json
update.lock
latest-request.json
latest-result.json
updater-session.jsonl
updater.log
launch-updater.sh
```

## Snapshot contract

The updater must receive a fixed request snapshot rather than reading live foreground state.

Required fields:
- `requestId`
- `projectRoot`
- launch timestamp
- tracked docs: `path`, `title`, optional `instruction`, optional fingerprint (`mtimeMs`, `size`)
- recent conversation slice: `role`, `text`, optional `timestamp`

Why:
- deterministic input
- no dependence on mutable foreground state
- supports race detection before edit

## Locking semantics

At most one updater job may run at a time per repo.

Lock tracks:
- `requestId`
- start time
- optional `pid`
- optional session file

Rules:
- live lock blocks new launches
- stale lock is reclaimed explicitly
- overlapping autoupdate jobs are forbidden

## Race policy

Before editing a doc, compare its current fingerprint to the snapshot.

If changed:
- skip that doc
- record the reason in the result artifact
- continue with the remaining docs

Why:
- avoid overwriting active foreground edits
- preserve progress on unaffected docs

## Launch model

The updater runs as a detached, separate Pi session.

Required properties:
- separate session file
- no foreground turn injection into the parent session
- captured log file
- explicit success/failure result artifact
- one-shot lifecycle: update docs, write result, exit

`@tintinweb/pi-subagents` may be studied as a reference for safe detached Pi launching, but no subagent extension should be imported for this feature.

## Updater prompt contract

The detached updater should:
- update only the listed magic docs
- re-read each target doc before editing
- be terse and high signal
- document architecture and WHY, not code trivia
- delete stale sections
- skip docs whose fingerprints changed after snapshot
- write a compact result artifact and exit

## Result contract

Result artifact must record:
- `requestId`
- completion time
- status: `completed` or `failed`
- changed docs
- unchanged docs
- skipped docs with reasons
- optional error string

## Reporting policy

The main session receives one terse result line only.

Examples:

```text
Magic docs updated: 1 changed, 2 unchanged, 1 skipped.
```

```text
Magic docs update failed: detached updater launch timed out.
```

No streaming progress or updater conversation should enter the main session.

## Failure semantics

Fail fast at explicit boundaries only.

Boundary-safe translation is allowed for:
- detached launch failure
- updater exit failure
- malformed result artifact
- stale lock handling

Not allowed:
- silent retries
- swallowing malformed JSON/result files
- ambiguous partial completion without a result artifact

## Validation

Required checks:
1. tracked docs are discovered from session-local tool results
2. idle trigger launches an updater job when eligible
3. updater runs in a separate session and exits cleanly
4. main session receives no injected maintenance turn
5. one-line completion/failure report appears
6. overlapping updater launches are suppressed by the lock
7. docs changed after snapshot are skipped predictably
8. malformed request/result artifacts fail visibly

## Decision summary

- restore autoupdate triggering
- move updates into a detached background Pi session
- keep the main agent context clean
- do not import a subagent extension
- allow only one updater job at a time
- use fixed snapshots and per-doc race skipping
- report back with one terse completion/failure line
