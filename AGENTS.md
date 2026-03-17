# Agent Notes

## Releases

1. Run `npm version <patch|minor|major>` and verify `package.json` updates.
2. Update `CHANGELOG.md` for the release.
3. Commit the release changes and tag with the same version.
4. Push commits and tags, then publish with `npm publish` if needed.

## Extensions

Pi extensions live in `./pi-extensions`. When working in this repo, add or update extensions there. You can consult the `pi-mono` for reference, but do not modify code in `pi-mono`.

## Porting extensions and skills

When porting or copying code from an external repository:
1. Check the upstream license before copying. Confirm it permits reuse (MIT, Apache-2.0, BSD, etc.).
2. Add an entry to `THIRD_PARTY_NOTICES.md` with source URL, included paths, license type, and copyright notice.
3. If no license file is present, note that explicitly in `THIRD_PARTY_NOTICES.md` and verify before redistribution.

## Upstream sync reminder

This repo is no longer in a GitHub fork network. Manually check upstream periodically:
- Upstream: `https://github.com/mitsuhiko/agent-stuff.git`
- Suggested cadence: every Monday
- Quick checklist:
  1. `git fetch upstream`
  2. `git log --oneline main..upstream/main`
  3. Cherry-pick selected fixes/features
  4. Run minimal validation
  5. `git push`

## Import provenance (extensions/skills)

Default provenance: unless explicitly listed otherwise below, repository content is sourced from `https://github.com/mitsuhiko/agent-stuff`.

Keep this list updated whenever importing or porting an extension/skill so source tracking stays explicit.

- `default (all other repo content unless listed below)` → `https://github.com/mitsuhiko/agent-stuff` @ `dff57a95a670` (`origin/main`)
- `pi-extensions/pi-autoresearch/*` → `https://github.com/davebcn87/pi-autoresearch` @ `21e7ae916fc6` (`origin/main`)
- `skills/autoresearch-create/SKILL.md` → `https://github.com/davebcn87/pi-autoresearch` @ `21e7ae916fc6` (`origin/main`)
- `pi-extensions/damage-control/*` → `https://github.com/cagdotin/agents` @ `d8974ff068b4` (`origin/master`)
- `pi-extensions/side-chat/*` → `https://github.com/nicobailon/pi-side-chat` @ `f1dba8bdb26e` (`origin/main`)
- `pi-extensions/pi-tasks/*` → `https://github.com/tintinweb/pi-tasks` @ `578b1c9a6b4a` (`origin/master`)
- `pi-extensions/pi-subagents/*` → `https://github.com/tintinweb/pi-subagents` @ `20d5c67fb239` (`origin/master`)
- `pi-extensions/pi-supervisor/*` → `https://github.com/tintinweb/pi-supervisor` @ `a6d8a501bae9` (`origin/master`)
- `pi-extensions/pi-schedule-prompt/*` → `https://github.com/tintinweb/pi-schedule-prompt` @ `ef7ab49f2988` (`origin/master`)

Also update `THIRD_PARTY_NOTICES.md` whenever this list changes.
