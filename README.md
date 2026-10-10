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

Artifacts land in `dist/` (e.g. `dist/mac-arm64/Eris.app`).

## Settings layers

| Layer | Path |
|-------|------|
| User | `~/Library/Application Support/Eris/settings.json` |
| Workspace | `<folder>/.eris/settings.json` |
| Agents | `<folder>/.eris/agents.json` |
| Rules | `<folder>/.eris/rules/*.md` |
| Secrets | Electron `safeStorage` (API keys) |

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
