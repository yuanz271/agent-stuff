# MAGIC DOC: Magic Docs Autoupdate Spec
*Focus on automatic update triggering, detached updater architecture, and result/reporting boundaries for the magic-docs extension.*

## Goal

Restore automatic magic-doc updates without injecting maintenance turns into the main agent conversation.

## Summary

`magic-docs` splits into:
- **foreground coordinator + judge** — track session-local magic docs, run the Haiku necessity check, launch updater, report one-line result
- **background updater** — run a separate one-shot Pi session that re-reads and updates the tracked docs, then exits

Why:
- the old auto-trigger policy was useful
- the old execution path polluted the main agent context
- the cheap necessity check can stay foreground, but the rewrite must not
- this feature needs a detached maintenance job, not a general subagent framework

## Scope

### In scope
- tracking magic docs from this session's `read` / `write` / `edit` results
- restoring idle-triggered autoupdate
- foreground Haiku necessity checks
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

Current rule:
- reset idle counter after a tool-active run
- increment on idle `agent_end`
- launch when:
  - `trackedDocs.size > 0`
  - `consecutiveIdleRuns >= 2`
  - `now - lastJudgeAt >= 5 minutes`
  - no active lock

The foreground Haiku judge decides whether an update is worthwhile. If it says no, remain silent.

## Architecture

### Foreground coordinator + judge
Responsibilities:
- detect and restore tracked docs
- maintain idle counters and cooldown
- run the Haiku necessity check against recent conversation
- build a fixed rewrite request only when the judge says an update is needed
- launch a detached updater job
- observe completion and emit one terse result line

### Background updater
Responsibilities:
- load the rewrite request
- treat the rewrite request as authoritative for whether rewriting should happen
- re-read each target doc from disk
- update only the listed docs
- skip docs that changed after snapshot
- write a result artifact and exit

## Runtime artifacts

Use a repo-local runtime directory:

```text
<repo>/.pi/magic-docs/
```

Runtime contents:

```text
state.json
update.lock
latest-request.json
latest-result.json
updater-session.jsonl
updater.log
launch-updater.sh
updater-system-prompt.md
```

## Rewrite request contract

The detached updater receives a fixed rewrite request rather than live foreground state.

Required fields:
- `requestId`
- `projectRoot`
- launch timestamp
- tracked docs: `path`, `title`, optional `instruction`, optional fingerprint (`mtimeMs`, `size`)
- foreground judge output: sanitized `reason`

Not included:
- raw recent conversation

Why:
- deterministic input
- no dependence on mutable foreground state
- prevents the detached rewrite worker from inheriting temporary foreground conversational constraints such as “do not edit in this response”
- supports race detection before edit

## Locking semantics

At most one updater job may run at a time per repo.

Lock tracks:
- `requestId`
- `pid`
- start time
- project root
- session file

Rules:
- live lock blocks new launches
- stale lock is reclaimed explicitly
- overlapping autoupdate jobs are forbidden

## Race policy

Before editing a doc, compare its current fingerprint to the rewrite request.

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
- treat the rewrite request as authoritative; the foreground judge has already decided an update is needed
- update only the listed magic docs
- re-read each target doc before editing
- be terse and high signal
- document architecture and WHY, not code trivia
- delete stale sections
- skip docs whose fingerprints changed after snapshot
- ignore raw foreground conversational control wording because that does not appear in the rewrite request
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

The main session stays silent when the foreground judge decides no update is needed.

It receives one terse result line only when a detached rewrite job finishes or fails.

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
2. idle trigger runs the foreground judge when eligible
3. no-op judge outcomes stay silent
4. updater runs in a separate session and exits cleanly
5. main session receives no injected maintenance turn
6. one-line completion/failure report appears
7. overlapping updater launches are suppressed by the lock
8. docs changed after snapshot are skipped predictably
9. malformed request/result artifacts fail visibly
10. detached rewrite does not inherit raw foreground conversational no-edit wording

## Decision summary

- restore autoupdate triggering
- keep the Haiku necessity judge in the foreground
- move rewrites into a detached background Pi session
- keep the main agent context clean
- do not import a subagent extension
- allow only one updater job at a time
- pass only sanitized judge output, not raw recent conversation, to the detached rewrite worker
- use fixed rewrite requests and per-doc race skipping
- report back with one terse completion/failure line
