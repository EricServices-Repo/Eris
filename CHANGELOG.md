# Changelog

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
