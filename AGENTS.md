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
