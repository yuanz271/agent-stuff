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

### 2. Find the current version

Inspect the repository to locate where the version is stored. Common locations:
- `package.json` → `"version"` field
- `pyproject.toml` → `[project] version` or `[tool.poetry] version`
- `Cargo.toml` → `[package] version`
- A `__version__` variable in a source file
- A dedicated `VERSION` file

Read the current version from whichever location applies. If multiple locations exist, update all of them.

### 3. Update the changelog

Read the `/update-changelog` skill and follow it to ensure `CHANGELOG.md` has an up-to-date `## Unreleased` section covering all commits since the last tag.

### 4. Confirm the version

Show the user the current version and the proposed `$NEW_VERSION`. Wait for confirmation before proceeding.

### 5. Bump the version

Edit the version file(s) in place to replace the current version with `$NEW_VERSION`. Do not use toolchain-specific version commands — edit the file directly so the process works regardless of language or toolchain.

Verify the version file now shows `$NEW_VERSION`.

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

- Always confirm the explicit version number with the user before making any changes.
- The working tree should be clean before starting. If it is not, warn the user.
- If `CHANGELOG.md` has no `## Unreleased` section, run `/update-changelog` first.
- If the version appears in multiple files, update all of them in the same commit.
