---
name: update-github
description: >-
  Publish a public Eris desktop release: bump/tag, push, and let CI upload
  installers to GitHub Releases plus the Eris-updates auto-update feed. Use when
  the user says /update-github, publish Eris release, ship to Eris-updates,
  public GitHub release, or asks to push a release to the public update feed.
disable-model-invocation: true
---

# /update-github

Publish Eris to the **public** auto-update feed:

**https://github.com/EricServices-Repo/Eris-updates**

That repo is the success target (electron-updater / client downloads). The private
`EricServices-Repo/Eris` release is only the source tag + notes; installers must
also appear on **Eris-updates**.

Pipeline:

1. Tag `vX.Y.Z` on `EricServices-Repo/Eris` (private source) from `main`.
2. CI (`.github/workflows/release.yml`) builds macOS + Windows into `dist/`.
3. CI uploads installers to:
   - Private notes: `EricServices-Repo/Eris` releases
   - **Required public feed:** `EricServices-Repo/Eris-updates` releases
     (`repository: EricServices-Repo/Eris-updates` + `ERIS_UPDATES_TOKEN`)

Do **not** confuse this with `/rebuild` (local unsigned app only) or a plain `git push`.
A release is **not done** until `gh release view vX.Y.Z --repo EricServices-Repo/Eris-updates`
shows zip/exe/`latest-*.yml` assets.

## Prerequisites

- Working tree **clean** (commit or stash first). `scripts/release.mjs` refuses a dirty tree when bumping.
- `gh` authenticated with `repo` scope: `gh auth status`
- Repo remote is `EricServices-Repo/Eris`
- Prefer releasing from `main` (or the branch you intend the tag to point at). If on `nightly`, confirm with the user before tagging, or merge to `main` first.

## Steps (do all, in order)

### 1. Preflight

```bash
git status
git branch --show-current
gh auth status
node -p "require('./package.json').version"
```

If the tree is dirty, stop and ask the user to commit/stash (or commit only if they already asked).

### 2. Choose release mode

| User said | Command |
|-----------|---------|
| `/update-github` (default) | `npm run release` (patch bump) |
| minor / major | `npm run release -- --bump minor` or `--bump major` |
| exact version | `npm run release -- --version X.Y.Z` |
| version already bumped in package.json | `npm run release:github` (`--no-bump`) |
| also build installers on this Mac | `npm run release -- --local-build` (mac only; CI still builds both) |
| dry run | `npm run release:dry` |

Default when unclear: **patch** via `npm run release`.

### 3. Run the release

From the repo root (needs network + git write):

```bash
npm run release
```

This will:

- Bump `package.json` / `package-lock.json` (unless `--no-bump`)
- Prepend `CHANGELOG.md`
- Commit `Release vX.Y.Z`
- Create annotated tag `vX.Y.Z`
- `git push origin HEAD` and `git push origin vX.Y.Z`
- Create the GitHub Release shell (`gh release create`)

CI then builds and publishes assets to **Eris** and **Eris-updates**.

Allow several minutes for CI (macOS + Windows runners).

### 4. Verify

```bash
VERSION="$(node -p "require('./package.json').version")"
gh release view "v${VERSION}" --repo EricServices-Repo/Eris
gh release view "v${VERSION}" --repo EricServices-Repo/Eris-updates
gh run list --repo EricServices-Repo/Eris --workflow=release.yml --limit 3
```

Confirm:

- Private release `vX.Y.Z` exists on `Eris`
- Public release `vX.Y.Z` exists on `Eris-updates` with zip / exe / `latest-*.yml` once CI finishes
- Release workflow is green (or still in progress — report status)

If Eris-updates is missing assets, wait for the workflow; the publish job needs `ERIS_UPDATES_TOKEN` in repo secrets (do not invent or print tokens).

### 5. Reply

One short block:

```markdown
**vX.Y.Z** published to Eris-updates.

- Public feed: https://github.com/EricServices-Repo/Eris-updates/releases/tag/vX.Y.Z
- Source release: https://github.com/EricServices-Repo/Eris/releases/tag/vX.Y.Z
- CI: https://github.com/EricServices-Repo/Eris/actions/workflows/release.yml
```

If CI is still running, say so and link the run. Do not claim Eris-updates success
until that release has assets.

## Rules

- **Only** run when the user explicitly asks for a public/GitHub/Eris-updates release (`/update-github` or equivalent).
- Do **not** force-push tags or delete remote tags unless the user explicitly requests it.
- Do **not** skip `gh auth` / clean-tree checks.
- Do **not** commit unrelated files (e.g. `.eris-push-src.tgz`, `.eris-push.patch`).
- Prefer CI for both platforms; use `--local-build` only if the user asks to attach local macOS artifacts too.
- Never print or request `ERIS_UPDATES_TOKEN`; it lives in GitHub Actions secrets only.
- `/rebuild` alone is **not** a public release.

## Reference

- Script: `scripts/release.mjs`
- Workflow: `.github/workflows/release.yml`
- Client feed docs: `docs/UPDATES.md`
- Feed config: `resources/app-update.yml` → `EricServices-Repo/Eris-updates`
