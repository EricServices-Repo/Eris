---
name: update-github
description: >-
  Publish the current package.json version of Eris. CI builds the macOS and
  Windows installers and uploads them to GitHub Releases on
  EricServices-Repo/Eris. Use when the user says /update-github, publish the
  Eris release, or ship the latest desktop build to GitHub.
disable-model-invocation: true
---

# /update-github

Publish the **version already in `package.json`** to:

**https://github.com/EricServices-Repo/Eris/releases**

That repository is the only release target. electron-updater reads
`latest-mac.yml` and `latest.yml` from those releases. Do not publish to
another repo.

A release is **not done** until this command shows the macOS zip, the Windows
setup exe, and both feed files:

```bash
gh release view "vX.Y.Z" --repo EricServices-Repo/Eris
```

Required assets:

| Platform | Files |
|----------|--------|
| macOS | `Eris-X.Y.Z-mac-arm64.dmg`, `Eris-X.Y.Z-mac-arm64.zip`, `latest-mac.yml` |
| Windows | `Eris-X.Y.Z-win-x64-setup.exe`, `latest.yml` |

Blockmaps may be attached with those files.

Do **not** confuse this with `/rebuild` (local unsigned app only) or a plain `git push`.

## Pipeline

1. Read `package.json` `version`. That is `X.Y.Z`. Do **not** bump it.
2. Commit that version if `package.json`, `package-lock.json`, or `CHANGELOG.md` are still uncommitted. Leave unrelated files unstaged.
3. Release from `main`. If the version lives on another branch, merge that branch into `main` and push `main` first. If the branch is `nightly`, confirm with the user before merging.
4. Run `npm run release:github` (`scripts/release.mjs --no-bump`). It tags `vX.Y.Z`, pushes the tag, and creates the GitHub Release on `EricServices-Repo/Eris`.
5. CI (`.github/workflows/release.yml`) builds macOS and Windows and uploads both installers onto that release.

## Prerequisites

- `gh` authenticated with `repo` scope: `gh auth status`
- Remote is `EricServices-Repo/Eris`
- Tag `vX.Y.Z` does not already exist. If it does, do not delete it unless the user explicitly asks. Report that the version is already tagged.

## Steps (do all, in order)

### 1. Preflight

```bash
git status
git branch --show-current
gh auth status
node -p "require('./package.json').version"
```

If unrelated edits are dirty, stop and ask the user to commit or stash them. A version bump left by `/rebuild` is not unrelated: commit `package.json`, `package-lock.json`, and `CHANGELOG.md` before tagging.

### 2. Command

| User said | Command |
|-----------|---------|
| `/update-github` | `npm run release:github` (no version bump) |
| also bump patch / minor / major first | `npm run release`, or `npm run release -- --bump minor` / `--bump major` |
| exact version | `npm run release -- --version X.Y.Z` |
| dry run | `npm run release:dry` |

Default is **no bump**. `/rebuild` already advanced `package.json`.

### 3. Run the release

From the repo root, on `main`, with network and git write:

```bash
npm run release:github
```

This commits `Release vX.Y.Z` if the changelog or version files changed, creates annotated tag `vX.Y.Z`, pushes `HEAD` and the tag, and creates the release:

https://github.com/EricServices-Repo/Eris/releases/tag/vX.Y.Z

CI then builds both installers and runs `gh release upload` to `EricServices-Repo/Eris`. Allow several minutes. macOS often finishes first. Windows usually takes longer.

### 4. Verify

```bash
VERSION="$(node -p "require('./package.json').version")"
gh release view "v${VERSION}" --repo EricServices-Repo/Eris
gh run list --repo EricServices-Repo/Eris --workflow=release.yml --limit 3
```

Wait until the release workflow is green, then confirm the asset names include:

- `Eris-${VERSION}-mac-arm64.dmg`
- `Eris-${VERSION}-mac-arm64.zip`
- `Eris-${VERSION}-win-x64-setup.exe`
- `latest-mac.yml`
- `latest.yml`

If assets are missing, wait for the workflow. Do not claim the release is downloadable before both platforms are listed.

### 5. Reply

```markdown
**vX.Y.Z** is on EricServices-Repo/Eris with macOS and Windows installers.

- Release: https://github.com/EricServices-Repo/Eris/releases/tag/vX.Y.Z
- CI: https://github.com/EricServices-Repo/Eris/actions/runs/RUN_ID
```

If CI is still running, say so and link the run.

## Rules

- **Only** run when the user explicitly asks for `/update-github` or a GitHub release.
- Publish the version in `package.json`. Do not bump unless the user asks for a new version.
- Do **not** force-push tags or delete remote tags unless the user explicitly requests it.
- Do **not** commit unrelated files (`.agents/` skills, `.eris-push-src.tgz`, `.eris-push.patch`).
- Do **not** upload to any repository other than `EricServices-Repo/Eris`.
- Prefer CI for both platforms. Do not attach a local Mac-only build unless the user asks.
- Never print GitHub tokens. The workflow uses `GITHUB_TOKEN` for `EricServices-Repo/Eris`.
- `/rebuild` alone is **not** a GitHub release.

## Reference

- Script: `scripts/release.mjs` (`npm run release:github` is `--no-bump`)
- Workflow: `.github/workflows/release.yml`
- Client feed: `resources/app-update.yml` and `package.json` `build.publish` → `EricServices-Repo/Eris`
- Docs: `docs/UPDATES.md`
