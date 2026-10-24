# Eris client updates (GitHub Releases)

Eris uses **electron-updater** against the public repository
[`EricServices-Repo/Eris`](https://github.com/EricServices-Repo/Eris).
Installers and `latest-mac.yml` / `latest.yml` are attached to that repo’s
releases, so clients need **no GitHub token**.

## Client flow (implemented)

1. On launch (after ~20s), if Settings → General → **Check for updates automatically** is on, the main process calls `autoUpdater.checkForUpdates()`.
2. Status is pushed to the renderer (`updates:status`): idle → checking → available / not-available → downloading → downloaded (or error).
3. UI:
   - **Update banner** at the top when an update is available / downloading / ready / failed
   - **Status bar version** (`v0.2.11`) — click to check; shows `↑` when an update is pending
   - **Eris → Check for Updates…** menu
   - **Settings → General → Updates** — auto-check, auto-download, Check / Open releases
4. **Install**: restart now, or install on quit (`autoInstallOnAppQuit`).
5. **Fallback**: on error (e.g. unsigned macOS build), offer **Open releases** →  
   https://github.com/EricServices-Repo/Eris/releases/latest

Disable all checks: `ERIS_DISABLE_UPDATES=1`.

Feed config lives in `package.json` → `build.publish` and `resources/app-update.yml`
(`EricServices-Repo/Eris`). The main process also calls
`autoUpdater.setFeedURL({ provider: 'github', … })` so local `--dir` builds work.

Quit and reopen Eris after a local rebuild — macOS `open` focuses an already-running
instance and will not reload a new `app.asar`.

CI publishes installers to the public `EricServices-Repo/Eris` release. Branch integration and the release source are governed by [GitHub workflow rules](./GITHUB-WORKFLOW.md): before v1.0.1, release candidates come from `dev`; v1.0.1 is promoted to `main` by pull request.

### Required release assets (CI already uploads these)

| Platform | Assets electron-updater needs |
|----------|-------------------------------|
| macOS | `Eris-*-mac-*.zip` (+ `.blockmap`), `latest-mac.yml` |
| Windows | `Eris-*-win-*-setup.exe` (+ `.blockmap`), `latest.yml` |

DMG is for humans; **zip** is what auto-update installs on Mac.

---

## Website / production checklist

To make updates production-ready beyond “CI puts files on a GitHub Release”, the **website and release pipeline** should cover:

### 1. Public download hub

- Page on **ericservic.es** (e.g. `/download` or `/eris`) with:
  - Current version + release date
  - macOS (Apple Silicon) `.dmg` / `.zip`
  - Windows x64 setup `.exe`
  - Link to full changelog
  - “What’s new” excerpt from `CHANGELOG.md` / GitHub release body
- Deep link that always resolves to **latest**:  
  `https://www.ericservic.es/eris/download/latest` → redirect to the current GitHub asset or a mirrored CDN URL

### 2. Stable update metadata endpoints (recommended)

GitHub Releases work, but a first-party feed is more reliable for branding and rate limits:

| URL | Purpose |
|-----|---------|
| `https://www.ericservic.es/eris/updates/latest-mac.yml` | Mirror of electron-updater mac feed |
| `https://www.ericservic.es/eris/updates/latest.yml` | Mirror of Windows feed |
| `https://www.ericservic.es/eris/updates/RELEASES` | Optional Windows Squirrel (if you ever switch) |

Then add a second `publish` provider (`generic`) or set `autoUpdater.setFeedURL` to the site. Keep GitHub as backup.

### 3. Code signing & notarization

Without signing, macOS Gatekeeper blocks in-place updates and Windows SmartScreen scares users.
Full setup: **[docs/SIGNING.md](./SIGNING.md)**.

| Platform | Secrets |
|----------|---------|
| macOS | `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (or `WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD`) |

CI signs when secrets exist; otherwise builds unsigned. Document “unsigned: manual download only” on the website until both are live.

### 4. Release notes API / page

- Human page: `/eris/releases` or GitHub releases embedded
- Machine-readable notes (already in GitHub release body) so the in-app banner can show “What’s new”
- Keep `CHANGELOG.md` as the source of truth; website and GitHub notes generated from it

### 5. Channels (optional but production-grade)

| Channel | Tag / feed | Audience |
|---------|------------|----------|
| `latest` | `vX.Y.Z` + `latest-*.yml` | Everyone (default) |
| `beta` | `vX.Y.Z-beta.N` + `beta-*.yml` | Opt-in in Settings |

Website needs separate download buttons and feed URLs per channel. Client setting: `general.updates.channel`.

### 6. Integrity & security

- Publish SHA-256 checksums next to each asset on the website
- HTTPS only; HSTS on ericservic.es
- Do not serve installers over plain HTTP
- electron-updater already verifies via `.blockmap` / YAML sha512 when assets are published correctly

### 7. Support & policy pages

- Minimum OS versions (macOS / Windows)
- Auto-update privacy note (checks GitHub or ericservic.es; no telemetry beyond version check)
- Rollback / “download previous version” archive
- Support contact when an update fails

### 8. Ops automation

- Tag `v*` → CI builds → upload assets → create/update GitHub Release (done)
- Website “latest version” widget reads GitHub API or a small JSON drop:  
  `https://www.ericservic.es/eris/updates/version.json` → `{ "version": "0.2.11", "releasedAt": "…" }`
- Status page if the update CDN / GitHub is degraded

### 9. In-app ↔ website consistency

| In app | Website |
|--------|---------|
| Open releases | Same canonical URL |
| Version in About / status bar | Shown on download page |
| Free/Pro upgrade links | Account billing on ericservic.es (already) |

### 10. QA matrix before calling updates “production”

- [ ] Signed Mac zip installs via Check for Updates
- [ ] Windows NSIS installs via Check for Updates
- [ ] Offline / 404 feed shows error + Open releases
- [ ] Auto-download off → prompt → Download
- [ ] “Later” then quit installs on next launch
- [ ] Downgrade blocked (no older feed wins)

---

## Quick test (packaged build)

```bash
npm run dist:dmg   # or dist:release:mac / dist:win
# Install the build, then:
# Eris → Check for Updates…  or Settings → General → Check for updates
```

Dev (`electron-vite`) reports updates as **disabled** (packaged only).
