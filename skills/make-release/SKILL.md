---
name: make-release
description: "Release this repository: bump version, update changelog, commit, tag, and show push instructions"
---

Release this repository. Version or release type: "$ARGUMENTS"

## Step-by-Step Process

### 1. Determine the target version

`$ARGUMENTS` can be:
- An explicit version (e.g. `1.6.0`) — use directly as `$NEW_VERSION`
- A release type: `patch`, `minor`, or `major` — read the current version first, then derive `$NEW_VERSION` by incrementing the appropriate segment.

If no argument is provided, ask the user which version or type to use.

### 2. Find the versioning tool and current version

Inspect the repository and environment to detect the best way to read and bump the version. Check in order:

1. **`bump-my-version`** — if `[tool.bumpversion]` or `.bumpversion.toml` exists, use `bump-my-version bump $RELEASE_TYPE` or `bump-my-version bump --new-version $NEW_VERSION`.
2. **`uv`** — if `pyproject.toml` exists and `uv` is available, use `uv version $NEW_VERSION`.
3. **`npm`** — if `package.json` exists and `npm` is available, use `npm version $NEW_VERSION --no-git-tag-version`.
4. **`cargo`** — if `Cargo.toml` exists and `cargo` is available, use `cargo set-version $NEW_VERSION`.
5. **Manual edit** — if no versioning tool is detected, locate the version string in `pyproject.toml`, `package.json`, `Cargo.toml`, a `VERSION` file, or a `__version__` variable, and edit it in place.

Always verify the version file reflects `$NEW_VERSION` after bumping.

### 3. Update the changelog

Read the `/update-changelog` skill and follow it to ensure `CHANGELOG.md` has an up-to-date `## Unreleased` section covering all commits since the last tag.

### 4. Confirm the version

Show the user the detected versioning tool, the current version, and the proposed `$NEW_VERSION`. Wait for confirmation before proceeding.

### 5. Bump the version

Run the versioning tool or apply the manual edit determined in step 2.

If the version appears in multiple files, update all of them.

### 6. Finalize the changelog

Edit `CHANGELOG.md`:
- Rename `## Unreleased` → `## $NEW_VERSION`
- Add a new empty `## Unreleased` section at the top

### 7. Commit and tag

```bash
git add -u
git commit -m "Release $NEW_VERSION"
git tag $NEW_VERSION
```

### 8. Show push instructions

Print the commands for the user to run manually — do NOT push automatically:

```bash
git push origin main && git push origin $NEW_VERSION
```

## Notes

- Always confirm the detected tool and version with the user before making any changes.
- The working tree should be clean before starting. If it is not, warn the user.
- If `CHANGELOG.md` has no `## Unreleased` section, run `/update-changelog` first.
- Prefer the automatic tool over manual edits — it handles multi-file version sync and formatting correctly.
