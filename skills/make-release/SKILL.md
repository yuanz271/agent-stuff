---
name: make-release
description: "Release this repository: bump version, update changelog, commit, tag, and show push instructions"
---

Release this repository. Version or release type: "$ARGUMENTS"

## Step-by-Step Process

### 1. Determine the target version

`$ARGUMENTS` can be:
- An explicit version (e.g. `1.6.0`) — use directly as `$NEW_VERSION`
- A release type: `patch`, `minor`, or `major` — compute the new version:
  ```bash
  CURRENT=$(node -p "require('./package.json').version")
  echo "Current: $CURRENT"
  ```
  Then derive `$NEW_VERSION` by incrementing the appropriate segment.

If no argument is provided, ask the user which version or type to use.

### 2. Update the changelog

Read the `/update-changelog` skill and follow it to ensure `CHANGELOG.md` has an up-to-date `## Unreleased` section covering all commits since the last tag.

### 3. Confirm the version

Show the user the current version and the proposed `$NEW_VERSION`. Wait for confirmation before proceeding.

### 4. Bump the version

```bash
npm version $NEW_VERSION --no-git-tag-version
```

Verify `package.json` now shows `$NEW_VERSION`.

### 5. Finalize the changelog

Edit `CHANGELOG.md`:
- Rename `## Unreleased` → `## $NEW_VERSION`
- Add a new empty `## Unreleased` section at the top

### 6. Commit and tag

```bash
git add package.json CHANGELOG.md
git commit -m "Release $NEW_VERSION"
git tag $NEW_VERSION
```

### 7. Show push instructions

Print the commands for the user to run manually — do NOT push automatically:

```bash
git push origin main && git push origin $NEW_VERSION
```

Optionally, if this package is published to npm:

```bash
npm publish
```

## Notes

- Always pass the explicit version number to `npm version`, never the release type, so aborted releases can be retried safely.
- The working tree should be clean before starting. If it is not, warn the user.
- If `CHANGELOG.md` has no `## Unreleased` section, run `/update-changelog` first.
