---
name: rebuild
description: >-
  Bump the Eris desktop app patch version and rebuild/launch the local macOS
  build. Use when the user says /rebuild, rebuild and version, rebuild & version,
  or asks to bump version and rebuild the app.
---

# /rebuild

Bump Eris to the next patch version, update changelog + lockfile, build the macOS app, and launch it.

## Steps (do all, in order)

1. **Read current version** from `package.json` (`version` field).

2. **Bump patch** (e.g. `0.2.30` → `0.2.31`) in:
   - `package.json`
   - `package-lock.json` (root `"version"` and `packages[""].version` only)

3. **Changelog** — prepend a `## X.Y.Z — YYYY-MM-DD` section at the top of `CHANGELOG.md` (under `# Changelog`). One short bullet for what just shipped; if unclear, use: `Desktop rebuild.`

4. **Build and launch** from the repo root:

```bash
npm run start:app
```

This runs `dist:mac` (unsigned arm64 dir build), quits any running Eris, and opens `dist/mac-*/Eris.app`. Allow ~3–5 minutes.

5. **Verify**:

```bash
/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' dist/mac-arm64/Eris.app/Contents/Info.plist
pgrep -x Eris >/dev/null && echo 'Eris running' || echo 'Eris not running'
```

Confirm the plist version matches the bumped version and Eris is running.

6. **Reply** with one line: `**X.Y.Z** is built and running at \`dist/mac-arm64/Eris.app\`.`

## Rules

- Do **not** create a git commit or tag unless the user explicitly asks.
- Do **not** publish a GitHub release unless the user explicitly asks — use `/update-github` for that.
- Do **not** skip the version bump (rebuild alone is not enough).
- Prefer `npm run start:app` over bare `dist:mac` so the new build launches.
- If `dist/mac-arm64` is missing but `dist/mac` exists, use whichever `dist/mac*/Eris.app` `start:app` opened.
