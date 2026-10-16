# Changelog

## Unreleased

- Usage tab meters a rolling 30-day window and can open any day in that window. Free limits use the same window.

## 0.2.41 — 2026-10-16

- Boot shows the saved account plan immediately, then refreshes EricServic.es and usage in the background.
- Goal check before DONE: reject premature “Finished” when edits failed, only tiny stubs were written, or a packaged app was requested but never produced.

## 0.2.40 — 2026-10-15

- Agent mode keeps workspace tools for launch/make-it-work asks; Fast can read the repo (no more invented Finder/Xcode steps).

## 0.2.39 — 2026-10-14

- Living project memory: agent runs and ask_user replies update `.eris/context.md` (auto/ask/off); chat chip + undo.
- Composer Full local context window raised from 8k → 16k (Lite stays 4k).

## 0.2.38 — 2026-10-14

- Desktop rebuild: higher-quality Composer/tool/router prompts + force tools for review/improve (no more “paste the folder structure”).

## 0.2.37 — 2026-10-14

- Agent clarifying questions pause inline (15s shrinking bar); no reply → continue with best judgment.
- Reject “please provide project structure/files” answers; stronger Composer tool playbooks + live Thinking stream.
- Fix: “review/improve the project…” no longer routes answer-only (no tools); auto-run `tree` when the model asks for structure.
- Higher-quality internal prompts: Composer/specialists, tool playbooks, router, Ask mode, inline AI, and compaction memory.

## 0.2.36 — 2026-10-14

- Local models: show completed (and in-progress) downloads above search under On this device.

## 0.2.35 — 2026-10-14

- Local model downloads resume from `.partial` via HTTP Range after cancel/stall (Retry → Resume).
- Desktop rebuild: Providers UX refresh + local GGUF KV session reuse across agent steps.

## 0.2.34 — 2026-10-14

- Settings → Providers: clearer add flow (preset grid), focused connect/edit, Ollama moved to Advanced.
- Local GGUF agent steps reuse one LlamaChatSession / KV cache (Cloud-style); steps 2+ prompt only the new turn.

## 0.2.33 — 2026-10-14

- Desktop rebuild: stop keeps partials, faster agent/send path, settings cache, mention index + Windows paths.

## 0.2.32 — 2026-10-14

- Stop keeps partial replies (sticky request id) instead of discarding streamed text.
- Agent TTFT: MCP sync + retrieval run in parallel after early status; LLM router capped at 400ms.
- Chat send skips `modelsStatus` IPC (uses in-memory catalog), optimistic user turn, parallel save.
- Cache resolved settings between writes; @-mention index no longer rebuilds on every tree tick.
- Windows-safe workspace path joins for open/attach/diff.

## 0.2.31 — 2026-10-14

- Faster chat: light `modelsStatus` on send/boot (no provider probes); Settings → Providers still probes live.
- Idle-warm default local GGUF after launch so the first local turn isn’t a cold load.
- Streaming replies paint as plain text with stick-to-bottom scroll (full markdown after the turn).

## 0.2.30 — 2026-10-14

- Fix: downloading a Local / Hugging Face model adds it to the catalog list immediately and shows live progress.
- Chat thinking: compact activity view (status + recent tools + short steps); full log stays behind a toggle; less verbose tool breadcrumbs.

## 0.2.29 — 2026-10-14

- Settings → Local models → GPU: compact device list only; Apple Silicon shows Metal + unified memory (no raw bus keys).

## 0.2.28 — 2026-10-14

- Settings → Editor: **Chat response font** (Sans / Mono / Serif) for assistant replies; code fences stay monospace.
- EricServic.es profile sync covers far more preferences (updates, telemetry, agent approvals, eGPU, intelligence, evals routing, background agents, GitHub prefs) while still keeping secrets, log paths, and workspace git links local.
- Fix model downloads (esp. Windows): stable monotonic progress, correct totals (`x-linked-size` / approx), Verifying/Installing phases after bytes finish, idle-timeout + rename retries so large files no longer sit at ~90%.
- Local models GPU selection: prefer **best GPU → eGPU → GPU → CPU**; Settings → Local models lists every detected GPU and highlights the selected one.

## 0.2.26 — 2026-10-13

- Desktop rebuild of Local models / Composer settings split / eGPU preference / update-banner semver guard.

## 0.2.25 — 2026-10-13

- Settings Models split into **Composer**, **Local models** (GGUF + eGPU), and **Providers** (Ollama + APIs).
- Fix: update banner no longer offers an older public feed release (e.g. 0.2.16) when this build is newer (unsigned Mac path).
- Settings → Composer shows the underlying GGUF identity (family, size, quant) for Lite and Full.

## 0.2.24 — 2026-10-13

- Chat model dropdown lists only ready/downloaded models (full catalog stays in Settings).
- **eGPU support**: detect attached eGPUs, prefer them for Local/Composer GGUFs (CUDA/Vulkan device env; Metal high-perf), and show status in Settings → Local models → GPU / eGPU.

## 0.2.23 — 2026-10-13

- Local models catalog expanded (Gemma, Phi-4 Mini, Mistral, more Qwen/Llama sizes) plus **Browse more on Hugging Face** and live Hub GGUF name search (paste repo / `.gguf` URL).
- Fix: chatting with `local:*` GGUFs no longer demands Ollama (`ollama serve`); readiness uses Local models status.

## 0.2.22 — 2026-10-13

- Settings → Models → **Local models**: download GGUFs that run inside Eris via node-llama-cpp — **no Ollama app required**.
- Ollama is optional (connect an existing daemon only); curated downloads no longer call `ollama pull`.

## 0.2.21 — 2026-10-13

- Settings → Models → Ollama: pick and download more local models (incl. **qwen3.8**), search/filter the catalog, or paste an ollama.com/library URL; pulled models register for chat.
- Ollama download errors: replace opaque `fetch failed` with a clear “start Ollama / ollama serve” message and Install Ollama link when the local API is down.

## 0.2.20 — 2026-10-13

- Settings → Usage: account vs device totals, last sync time, and a soft “Syncing…” state when profile `usage.php` is slow/offline.
- Faster first Cloud job: prefetch health/model status after login; chat shows “Composer Full warming on cloud…” instead of a silent wait.
- Diff Review: primary **Commit & Push** (stage → commit → push) with a default message after Keep.
- Builtin model install UX: Retry / Open URL on Hugging Face failures; download progress survives closing Settings.
- Usage metrics sync to **www.ericservic.es** profile (`/api/eris/v1/usage.php`) — desktop + Cloud Agent; Free caps use max(local, profile).

## 0.2.19 — 2026-10-12

- Builtin model download: Electron `net.fetch` + Node fallback and clearer Windows errors (fixes opaque `TypeError: fetch failed`).
- Desktop rebuild: Cloud Agent work runs inline in chat thinking; Agents tree / right-column Agents tab / Background hand-off removed.
- Cloud Agent **0.2.22**: report Cloud Agent jobs to profile `usage.php`; Free gate uses max(local, profile).
- Cloud Agent **0.2.21**: fleet management — enroll/heartbeat with EricServic.es, pull/push remote settings (`/v1/fleet/*`), website API stubs under `cloud-agent/website-stubs/`.
- Cloud Agent **0.2.20**: stop VM crash loop on CPU boot — defer GGUF RAM load until first job, stop queued+running on safe-boot, default ctx **2048**, slower systemd restart backoff.
- Cloud Agent **0.2.19**: port **:80** status page is a usage overview (live capacity, today outcomes, free-plan caps, process metrics, plan/status bars, masked top users, recent audit).
- Cloud Agent **0.2.18**: keep GGUF loaded; reuse KV/`LlamaChatSession` across tool steps; tool `maxTokens` ~512; auth cache; desktop SSE (poll fallback); skip file seed when cloning; debounced `jobs.json` writes; CPU mem cap 8g.
- Cloud Agent **0.2.17**: CPU-only hosts cap llama to **2 threads** + 4k context and Quadlet `--cpus=2` so inference cannot peg the VM and kill SSH.
- Cloud Agent **0.2.16**: status page **Force kill all** (nginx `:80` → `:8080`); auto `admin.token`; `POST /admin/kill-all`; Settings → Agent **Stop all my jobs**.

## 0.2.18 — 2026-10-12

- Agent mode runs Cloud Composer **inline in chat** (thinking / tools / answer / diffs); local Lite is a silent fallback — not a background Agents-panel job.
- Removed left-sidebar Agents tree and right-column Agents tab; no Background hand-off — all agent work stays in the main chat thinking stream.

## 0.2.17 — 2026-10-12

- Agents panel and chat UI no longer expose Cloud vs Local labels or buttons.
- Connection strip no longer banners Cloud Agents offline/timeout (status bar only).
- Cloud Agent: CPU-only install (`--cpu`), private-repo clone docs, Podman Quadlet as systemd, public status page on port 80, root-store image build fix.

## 0.2.16 — 2026-10-12

- Local ↔ cloud handoff: **Continue on cloud** / **Continue local** (chat context attached).
- Explorer **Agents** home lists local + cloud jobs; open Agents panel from there.
- Diff Review: **Stage kept**, **Commit…**, **Open PR…**.
- Faster Tab/ghost complete (280ms); hint when chat owns the model.
- **Codemap** panel: index stats, symbols, links to Context/Rules/Skills.
- Settings: search across all pages + preference fields.
- Connection strip: Cloud Agents / models degraded states (dismissible).
- Feedback: recent submissions history on this Mac.
- Onboarding: **Try it** step + **Start guided chat** first-win path.
- Cloud Agent **0.2.13**: EricServic.es Bearer auth + plan limits, durable resume/continue, SSE job events, shell sandbox, private clone + optional PR, richer artifacts, structured tool parsing, metrics/audit, fair multi-tenant queue. Desktop sends account + GitHub tokens automatically.

## 0.2.15 — 2026-10-12

- Report a Bug stays fully in-app: no GitHub browser draft, no Help-menu “open feedback on GitHub”. Submits via EricServic.es relay or built-in credential.
- Settings → **Feedback** page: Bug / Idea / Question chooser, attach toggles, env chips, in-place success — Help and Command Palette open this page.
- Settings UX: grouped sidebar (App / AI / Project / Editor), shared section chrome, **Logging** as its own page (viewer + preferences).
- CI: Windows Authenticode signing when `WIN_CSC_*` / `WINDOWS_CERT_*` secrets are set (see `docs/SIGNING.md`).

## 0.2.14 — 2026-10-12

- In-app **Report a Bug** (Help menu, Command Palette, Settings → General): submits diagnostics + redacted logs to `EricServices-Repo/Eris-feedback` via the EricServic.es relay (preferred) or a build-in credential — no user GitHub token or browser draft. See `docs/FEEDBACK.md`.

## 0.2.13 — 2026-10-12

- Multi-file Diff Review: file tree with +/- stats, Monaco side-by-side / inline DiffEditor, hunk navigation (n/p), expand/compact drawer.
- Keyboard: `j`/`k` next/previous file while reviewing agent or Cloud Apply changes.
- Client updates use the public `EricServices-Repo/Eris-updates` feed (no GitHub token on clients); CI mirrors installers there.

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
