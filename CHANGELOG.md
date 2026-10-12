# Changelog

## 0.2.12 — 2026-10-12

- In-app updater against GitHub Releases (banner, Settings → General, status-bar check); see `docs/UPDATES.md`.
- Cloud Agent jobs return a patch artifact bundle; Eris **Apply changes** opens Diff Review.
- Cloud Agent Docker: reproducible builds, tini/SIGTERM, resumable model download, `ready` health, VM `INSTALL.md` + `rebuild.sh`.

## 0.2.11 — 2026-10-12

- Cleaner EricServic.es account/sync Settings UX; session expiry prompts re-login.
- Status strip for Cloud/Ollama/auth/quota issues; StatusBar shows Free/Pro remaining requests.
- Faster first paint (lazy chat/git/search/debug); defer model probes on workspace open; cache secrets.json in memory.
- Simplify Models Settings (default picker, compact Composer/Ollama rows, cloud providers behind Manage).
- Redesign Context Settings around a pinned Summary, quick notes, and a quieter full-document editor.
- Remove Thunderbird/Outlook email-context pull and the `read_email` agent tool.

## 0.2.10 — 2026-10-12

- macOS app icon uses a rounded white badge behind the logo so it stays visible in Dock/Finder.

## 0.2.9 — 2026-10-12

- App icon is the logo alone on a transparent background (no black/charcoal square).

## 0.2.8 — 2026-10-12

- Rebuild of boot/settings hardening from 0.2.7 (splash gate, non-throwing settings resolve, legacy connection type migration).

## 0.2.7 — 2026-10-12

- Fix infinite “Loading Eris…”: splash no longer requires both settings + a flag (error path previously set the flag while leaving `settings` null forever).
- Boot has an 8s hard ceiling, settings resolve never throws into IPC, and legacy connection types are rewritten on disk at startup.
- Add a UI error boundary / retry screen instead of a permanent splash.

## 0.2.6 — 2026-10-12

- Stop blocking the Electron main thread on login-shell PATH (`zsh -ilc`) at startup — that was stalling boot IPC and prolonging “Loading Eris…”.
- Show an HTML splash immediately; load settings/state in parallel and defer the first Cloud Agents health probe.

## 0.2.5 — 2026-10-12

- Coerce legacy/synced model connection `type: "openai"` (and similar presets) to `openai-compatible` so EricServices login/sync no longer fails schema validation.

## 0.2.4 — 2026-10-12

- Clear the launch “Loading Eris…” screen after settings load; probe models/skills in the background.
- Cap OpenAI-compatible / Ollama model listing at 2.5s and probe connections in parallel so a dead local server cannot stall boot.

## 0.2.3 — 2026-10-12

- Store API tokens in local `secrets.json` only — no macOS Keychain / Electron `safeStorage`.
- Disable Chromium Keychain password-store so login/sync no longer prompts for Keychain access.
- Pass the issued EricServices token into post-login sync so profile sync does not depend on a secret re-read.

## 0.2.1 — 2026-10-12

macOS build (Apple Silicon). Download the `.dmg` or `.zip`, open, and move Eris to Applications.

### Changes
- Ship Cloud Agents HTTP hardening and Settings metrics for 0.2.1. (46e0870)
- Add multi-agent orchestration and a self-hosted Cloud Agent worker. (a7cf157)
- Merge pull request #3 from EricServices-Repo/cursor/ollama-model-usage (63ac618)
- Ship 0.2.0: evals, code intelligence, and background worktree agents. (fff14e5)
- Harden trust and packaging, upgrade Electron, and add CI quality gates. (cdace1e)
- Merge pull request #2 from EricServices-Repo/cursor/ollama-model-usage (2dfe3d1)
- Add TurnPlan chat routing for agents and models. (e445fd0)
- Fix packaged shell load and ship GitHub release tooling. (f856c66)

All notable releases of Eris are listed here. Versions follow [semver](https://semver.org/) in `package.json` and ship as GitHub Releases tagged `vX.Y.Z`.

## 0.2.1 — 2026-10-11

- Route “build/create an app or project” prompts as edit turns so the agent writes files instead of answering with setup instructions.
- Stop treating conversational “make a …” as a Makefile `run` intent.

## 0.2.0 — 2026-10-11

- Eval harness with built-in tasks, scoreboard, and routing that prefers models with better intent scores.
- Code intelligence: tree-sitter symbols, local/connection embeddings, multi-language LSP (Python/Go/Rust), and agent tools `find_references` / `semantic_search` / `related_files`.
- Background agents that each run in a private git worktree, with Agents inbox merge/discard.
- Workspace trust, sandboxed renderer FS scoping, Electron 44, smaller package, lazy-loaded editor/terminal/settings.

## 0.1.0 — 2026-10-10

- Initial public packaging baseline for macOS (Apple Silicon).
- Local distribution via `npm run dist:mac` / `dist:release`.
- GitHub Release publishing via `npm run release` and `.github/workflows/release.yml`.
