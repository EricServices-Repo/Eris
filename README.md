# Eris

macOS AI IDE with workspaces, a built-in Composer agent, and layered project settings.

## Requirements

- Node.js 20+
- macOS

## Develop

```bash
npm install
npm run dev
```

## Build macOS app

```bash
npm run dist:mac
```

Artifacts land in `dist/` (e.g. `dist/mac-arm64/Eris.app`). Version comes from `package.json` (`app.getVersion()` / status bar).

### Release builds (macOS + Windows)

One app version in `package.json` (semver). Artifacts land in `dist/`:

| Command | Output |
|---------|--------|
| `npm run dist:release:mac` | `Eris-<ver>-mac-<arch>.dmg` / `.zip` |
| `npm run dist:release:win` | `Eris-<ver>-win-x64-setup.exe` |
| `npm run dist:mac` | Unpacked `.app` (dev) |
| `npm run dist:win` | Windows NSIS installer |

Native modules require building each OS on that OS (or CI). Cross-compiling Windows on a Mac is not supported for releases.

### Publish a GitHub Release

Requires [GitHub CLI](https://cli.github.com/) (`gh auth login`) with `repo` scope, and a clean git tree.

```bash
# Bump patch, changelog, tag vX.Y.Z, push → CI builds macOS + Windows and uploads
npm run release

# Minor / major / exact
npm run release -- --bump minor
npm run release -- --version 0.3.0

# Current package.json version (no bump)
npm run release:github

# Also build installers for *this* machine into dist/ and upload them
npm run release:local

npm run release:dry
```

Pushing a `v*` tag always runs `.github/workflows/release.yml`:

1. **macos-latest** → macOS dmg/zip into `dist/`
2. **windows-latest** → Windows `.exe` into `dist/`
3. Publish both to the GitHub Release for that tag

```bash
git tag v0.2.3
git push origin v0.2.3
```

## Settings layers

| Layer | Path |
|-------|------|
| User | `~/Library/Application Support/Eris/settings.json` |
| Workspace | `<folder>/.eris/settings.json` |
| Agents | `<folder>/.eris/agents.json` |
| Rules | `<folder>/.eris/rules/*.md` |
| Secrets | Local `secrets.json` in userData (API keys; no OS Keychain) |

Workspace overrides user overrides defaults. Change scope in Settings with the User / Workspace control.

## Workspaces (self-contained)

Each workspace is a folder. Shell, agent `run`, verify, and debug execute with `cwd` set to that folder and prefer local tools:

- `node_modules/.bin` (after `npm` / `pnpm` / `yarn` / `bun` install)
- `.venv/bin` or `venv/bin` when present
- npm cache under `.eris/cache/npm` (not global installs)

**Host prerequisites** (once on the Mac, not per project): Node.js 20+ with `npm` on `PATH`. Optional: Git (GitHub panel), Python 3 (venv projects).

Installs stay in the workspace (`npm install`, `npm install <pkg>`). Global installs (`npm -g`) are blocked in the agent.

## Keyboard

| Shortcut | Action |
|----------|--------|
| ⌘O | Link folder as workspace |
| ⌘⇧N | New workspace |
| ⌘S | Save |
| ⌘, | Settings |
| ⌘⇧P | Command palette |
| ⌘L | New agent chat |
| ⌘↵ | Send chat message |
