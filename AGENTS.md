# Agent Notes

## Git

- Do not run `git push` without explicit user instruction. Commit freely, but always wait for "push" or "commit and push" before pushing to remote.

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

This repo is no longer in a GitHub fork network. Refresh the cached upstream checkout before syncing changes from it:
- Upstream: `https://github.com/mitsuhiko/agent-stuff.git`
- Suggested cadence: every Monday
- Quick drift check for imported sources: `uv run scripts/check-import-upstreams.py`
- Quick checklist:
  1. `git fetch upstream`
  2. Inspect the updated remote state or refreshed cached checkout
  3. `git log --oneline main..upstream/main`
  4. Cherry-pick selected fixes/features
  5. Run minimal validation
  6. `git push`

## Import provenance (extensions/skills)

Default provenance: unless explicitly listed otherwise below, repository content is sourced from `https://github.com/mitsuhiko/agent-stuff`.

Keep this list updated whenever importing or porting an extension/skill so source tracking stays explicit.

- See `UPSTREAMS.md` for the canonical current upstream pins used by `scripts/check-import-upstreams.py`. It is maintained per skill/extension, not per file.
- `pi-extensions/websearch/*` → original work, not ported from upstream

Also update `THIRD_PARTY_NOTICES.md` whenever provenance records change.
