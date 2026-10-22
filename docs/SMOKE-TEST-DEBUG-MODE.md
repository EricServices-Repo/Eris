# Smoke Test and Build Debug Mode Design

**Purpose:** Define how Eris should let developers run deterministic agent simulations, real-model smoke tests, and build checks from the application, then inspect and share failures. This document is a design proposal for future implementation models; it does not change application behavior.

**Review date:** 2026-10-21  
**Repository version:** `0.4.6` working tree  
**Primary UX destination:** expand the existing Evals/Debug experience, or create a dedicated **Build & Agent Diagnostics** panel linked from it.

## Summary

Eris has useful existing pieces:

- `tests/chat-agent-smoke.test.ts` runs complex agent-loop cases with a stubbed model stream and scripted tool replies.
- `tests/agent-question-corpus.test.ts` iterates the 10,000 natural-language prompts with simulated responses.
- `electron/main/services/corpus-debug-runner.ts` can send a selected real model questions from the 10,000-item corpus using disposable fixture workspaces and save JSONL plus Markdown.
- `src/features/evals/EvalsPanel.tsx` can start corpus chunks and eval suites in the running app.
- `package.json` runs `test:agents` as the `prebuild` hook and has separate `typecheck`, `lint`, `test`, `check`, and build commands.

The missing product is a cohesive debugging workflow that answers: **What exact path was tested? Which model response caused the failure? Was routing wrong, did the model emit invalid tools, did execution fail, or did the test expectation fail? Can I replay the failure without spending tokens again? Is this build ready?**

Build three explicitly labeled run modes and one shared run-artifact format:

1. **Deterministic simulation:** mocked model responses, repeatable, no model inference/network needed; test protocol and workflow behavior.
2. **Real-model smoke:** selected configured model, small curated labeled scenarios, isolated fixture projects, actual model calls; test model/tool quality.
3. **Full corpus run:** current 10,000 prompt corpus in resumable chunks; use for broad profiling, not as the primary release gate.
4. **Build validation:** typecheck, targeted test suites, complete test suite, lint, production build, and packaging checks, with clear stage outputs and an optional isolated build directory/worktree.

Every run must identify which mode it used. A fake model reply must never be shown as a real-model result.

## Current behavior and limitations

### Automated smoke tests are deterministic but do not exercise live model quality

`tests/chat-agent-smoke.test.ts:25-36` replaces `streamModelChat` with a queue of scripted strings/native calls. Its scenarios exercise the real agent loop and assert workspace changes/events (`:182+`), but provider behavior, model sampling, latency, tool grammar quality, and context adherence are simulated.

`tests/agent-question-corpus.test.ts:7-13,274-305` also mocks the model stream. It deterministically derives expected intent/agent and generated write/read/command responses from each question (`:200-249`). This is useful for broad software-path coverage, but cannot establish that a real model understands all 10,000 prompts.

### The in-app 10,000-question runner uses real inference but has coarse correctness checks

`electron/main/services/corpus-debug-runner.ts:50-60` validates the prompt file contains exactly 10,000 numbered questions. It creates the same generic four-file TypeScript fixture for every question (`:63-96`), routes with `planChatTurn`, then directly builds an eval task and calls `runEvalTask` (`:284-315`). The runner processes questions sequentially and checkpoints every configured chunk (`:273-340`).

Its checks are broad: nonempty answer, zero tool errors, and either any changes for an `edit` intent or no changes for all other intents (`:98-105`). The corpus has no authoritative expected intent, expected agent, expected file change, or semantic outcome per question. Thus a bad classification can produce an easy matching check; e.g. a code request misclassified as read-only can pass `no_changes`. The 10,000 count is a scale/stress count, not equivalent to 10,000 verified product outcomes.

The runner uses normal `planChatTurn`, but it bypasses the complete production chat stream path. Production intake, semantic re-resolution, task creation/persistence, `buildChatMessages`, streaming IPC, approval UX, renderer state, and final chat-job outcome live in `electron/main/ipc/chat-stream.ts:169-260,272-320,321+`. Corpus execution goes directly from the plan to `runEvalTask` (`corpus-debug-runner.ts:284-315`). Label it **real-model agent corpus run** unless an end-to-end mode is added.

### Evals UI can start tests but is not a failure debugger or build console

`src/features/evals/EvalsPanel.tsx:17-52` loads suite, scoreboard, and corpus run summaries. Its corpus controls select start/count/chunk/step cap and launch/cancel/export (`:131-247`). The general suite controls launch/cancel selected tasks (`:248-301`). Current UI focuses on a status string, aggregate scoreboard, and recent results (`:54-98,303-340`). The 10,000 corpus UI acknowledges the distinction between simulated fast tests and real-model runs (`:342-345`), but does not give the user one stage-by-stage failure trace or response replay workflow.

### Build scripts have a useful gate but no app-facing stage diagnostics

`package.json:9-20,28-37` defines `prebuild` as `npm run test:agents`; that command explicitly enumerates a curated set of Vitest files (`:29`). The full `npm test`, typecheck, lint, client checks, and build are separate commands (`:28-37`). This is a reasonable fast gate, but users need to see the selected gate, every included test file, exclusions, stage duration, and exact failure output. Build debugging should not imply that `test:agents` equals the whole `check` pipeline.

`EvalTaskSchema` defines `timeoutMs` (`src/shared/evals.ts:33-44`), but `runEvalTask` does not apply the per-task deadline around agent execution (`electron/main/services/eval-runner.ts:230-301`). This should be fixed before long in-app suites are relied on for build feedback.

## Product design

### A. Diagnostics home

Create one “Build & Agent Diagnostics” surface with tabs or sections:

- **Quick checks** — fast deterministic smoke, intent/tool protocol checks, typecheck, and prebuild suite.
- **Real model** — selected-model smoke scenarios and controlled comparisons.
- **Corpus** — resumable 10,000-question chunk runner.
- **Build** — typecheck → targeted tests → full tests → lint → production build/package checks.
- **Run history** — saved runs, stage outcomes, export, and replay.

Expose summary status in the main app: ready, running, failed, cancelled, or stale. Keep long-running work off the Electron UI thread and display progress, elapsed time, cancel, and last completed checkpoint.

### B. Three run modes with hard labeling

#### 1. Deterministic simulation mode

Use a pluggable `ModelAdapter` interface. Production provider adapters call the selected model; a scripted adapter returns recorded responses or scenario fixtures. A scenario should specify:

- User message, mode, project fixture, expected route/intent/agent/tool policy.
- Model message sequence, including malformed tool calls, refusals, timeouts, empty output, duplicate calls, tool errors, and corrections.
- Expected tool calls and effects, expected changed files/diff, expected verification outcome, and expected final status.
- Optional seed and exact protocol/model-adapter version.

Run scenarios through the same orchestration and workflow code as production. Mock only at a deliberate boundary (model transport, external service, host OS process); don’t mock away the code path under test. For IPC integration tests, run a real `chat-stream` handler with scripted model transport and test the route/task/stream events as production would.

Use this mode for fast prebuild and deterministic regression tests. Label it in UI and artifacts as **SIMULATED MODEL RESPONSES**.

#### 2. Real-model smoke mode

Run a small curated suite (suggest 15–50 cases) with actual configured model calls. Start with one model and one request at a time. The curated suite should include representative:

- Answer, workspace explanation, review, plan, explicit edit, verify, and command requests.
- New/empty project scaffolding, existing-project change, multiple-file change, and existing test update.
- Invalid tool JSON, wrong argument shape, unavailable tool, stale file, denied command, model refusal, cancellation, and context pressure.
- Language/framework fixtures actually supported by Eris.

Each case must have an oracle: expected intent class, permission scope, source evidence requirement, allowed changed paths, mutation requirement or prohibition, verification condition, and final status. Use deterministic file/diff assertions for code effects; use a small explicit rubric or human review for answer quality. Never declare a run “passed” solely because the model returned nonempty text.

Use selected real model settings and actual request path, but isolated temp workspaces. No production project writes. Network calls should be explicit in the run header, cancellable, and cost/token estimate shown where provider usage is available. Label artifacts **REAL MODEL** with model/provider/version/config and sampling settings.

#### 3. Full-corpus mode

Keep the 10,000 prompts for broad routing/stability analysis, but split its claims:

- **Offline corpus audit:** corpus count/format, deterministic classifier, schema/parser cases, and fixture checks; no model cost.
- **Real-model sampled corpus:** randomly or stratified selected slices (e.g. 50, 250, 1,000); real calls in chunks with cost/duration estimates.
- **Full 10k run:** explicit long job with checkpoints, pause/cancel/resume, throughput estimate, and clear warning that weak generic oracles provide profiling rather than verified task quality.

For the broad corpus, first add labels/tags for expected intent category and capability family, or report classification confidence and human-label coverage. Do not use unlabelled pass percentage as a ship gate.

### C. One diagnostic artifact per run

Create a versioned `DebugRunArtifact` persisted locally as summary JSON plus append-only JSONL (or SQLite if query performance becomes a problem). Store:

- Run ID, run mode, start/end/status, app version, source commit/build ID, OS/architecture, app build stage/config, and corpus/suite/scenario IDs and hashes.
- Model provider/ref, model/runtime version if available, temperature/seed, context window, tool adapter/protocol version, and whether calls were simulated or live.
- Route input classification, task contract, scope and permissions, selected agent/model, and route reason.
- Context manifest: included file paths, excerpt hashes/line ranges, truncations/omissions, and retrieval results. Avoid storing file contents by default.
- Ordered model-turn, tool-call, tool-result, recovery, approval, verification, and terminal events with timestamps, durations, failure category, and redacted diagnostics.
- Changed paths and diff hash; optionally include patch in an export only with explicit user choice.
- Reproducibility info and limitations: model outputs are nondeterministic; provider state/rate limits can differ.

Store request/response text only in a separate opt-in setting, locally, with a visible PII/code warning and retention limit. Default artifacts should capture protocol metadata, hashes, errors, and tool effects without exporting source code or secrets.

### D. Failure drill-down and response replay

For every failed case, show a timeline:

1. Original request and mode.
2. Expected vs actual intent/route/task scope.
3. Selected project, source files inspected, and context manifest.
4. Each model turn (redacted/opt-in raw), tool call, schema validation, execution result, and approval.
5. Recovery decision and whether it changed agent, model, protocol, context, or task plan.
6. Actual diff, verification command/output/exit code, and exact failed oracle.
7. Suggested next action tied to failure category.

Provide two replay actions:

- **Replay recorded responses:** use stored model outputs as a scripted adapter against the current code, to isolate whether a parser/execution/verification change fixes a prior issue without another model call.
- **Rerun with live model:** repeat the request with current model/settings and record it as a new run, never overwrite original evidence.

Replay must be sandboxed and block external side effects by default. A captured `run`, MCP, network, or image-generation call must require an explicit simulated stub or new user approval; a prior approval must never be replayed as authorization.

### E. Build validation workflow

Add named, versioned profiles:

| Profile | Stages | Intended use |
| --- | --- | --- |
| **Quick** | static smoke tests + changed-area targeted tests + typecheck (configurable) | Fast feedback during iteration |
| **Prebuild** | exact `prebuild` gate, including `test:agents` | Match what `npm run build` requires |
| **Full check** | typecheck + lint + complete `npm test` | Thorough local validation |
| **Package** | full check + platform production build/package validation | Release candidate check |

For each stage show command, cwd, duration, exit status, bounded stdout/stderr, log path, and whether the stage was skipped/cancelled. Capture build artifacts and diagnostics with hashes; do not collect environment secrets. A build failure must retain all preceding successful outputs and allow the failed stage to be rerun.

Run workspace commands using existing command-approval and workspace trust policies. Prevent concurrent builds/evals that would mutate the same output directory; offer an isolated worktree or disposable source copy for package checks. Clearly distinguish `prebuild` from `npm run check`; do not silently replace one with the other.

### F. Release readiness report

At the end, create a concise report:

- Overall: **PASS**, **FAIL**, **CANCELLED**, or **INCOMPLETE**.
- Exact profile and stages run; skipped stages and why.
- Test and model mode counts (simulated vs live) separately.
- Pass/fail counts by scenario, intent, stage, model, and failure category.
- Relevant diff paths and verification evidence.
- Performance: median/p95 first response, run duration, tool errors, retries, and (where available) tokens/cost.
- Regressions vs selected baseline, with direct links to case timeline/artifact.

Do not collapse an unrun real-model check into a deterministic test pass. Do not claim full build readiness if only the fast prebuild gate passed.

## Suggested implementation architecture

### 1. Shared boundaries

- `DebugRunCoordinator`: create, start, cancel, resume, persist, and finalize runs.
- `RunProfileRegistry`: versioned deterministic/real-model/corpus/build profiles.
- `ModelAdapter`: provider-neutral stream interface; `LiveModelAdapter` delegates to current `streamModelChat`; `ScriptedModelAdapter` consumes scenario/recorded outputs.
- `ChatOrchestrator`: extracted production intake → route → task contract → prompt → agent runner → outcome pipeline shared between chat IPC and in-app diagnostics. Keep IPC responsible for transport/events and user approvals, not duplicated task logic.
- `ScenarioOracle`: explicit route, effect, diff, verification, and answer-quality checks.
- `DebugRunStore`: append-only events and searchable summaries, with size cap/retention.
- `ArtifactExporter`: redacted JSONL/JSON/Markdown bundle; optional patch and transcript explicitly opted in.

The core design goal is **one orchestration path for chat and live smoke tests**. A test harness may substitute the model transport and workspace sandbox, but should not reimplement routing or task-contract flow.

### 2. App IPC and UI

Add typed APIs for `listDebugRuns`, `startDebugRun`, `cancelDebugRun`, `resumeDebugRun`, `getDebugRun`, `replayDebugRun`, `exportDebugRun`, and streaming `onDebugRunEvent`. Validate every IPC payload in the main process. UI should use event sequence numbers and durable run state so a panel switch/reload does not lose progress.

Make a case table/filterable by status, intent, model, failure category, latency, and changed files. A click opens the timeline. Include a “copy diagnostic bundle” button with a preview of included content and explicit code/transcript opt-in.

### 3. Persistence and privacy defaults

- Default to local-only storage under app user data.
- Keep summary metadata separate from optional raw prompts/model outputs.
- Redact credential-looking fields, environment variables, auth headers, and absolute home-directory paths from shared exports.
- Provide retention caps, delete-one-run, delete-all, and export preview.
- Do not upload runs automatically. Bug report integration should attach only after user reviews and consents.

## Phased implementation plan

### Phase 0 — Correctness and naming (small, immediate)

- Fix per-task eval timeout and abort cleanup.
- Rename current corpus UI/report from “real-model smoke test” to “real-model corpus run” unless the run traverses full production chat intake.
- Add expected-intent labels and better oracles to a small curated set.
- Make run mode (`simulated`/`real model`) impossible to omit from UI and saved result.
- Explain `test:agents` vs full `npm test`/`check` in the build UI.

### Phase 1 — Deterministic in-app replay

- Extract and share the production chat orchestration boundary.
- Add scenario fixtures and scripted model adapter.
- Run curated simulated end-to-end cases in the app, including injected failure paths.
- Add per-case timeline, failure categories, JSONL/Markdown export, and replay-recorded-responses.

### Phase 2 — Real-model quality smoke

- Add 15–50 curated labeled cases and real-provider adapter.
- Execute against disposable project fixtures with strict command/MCP/external-effect limits.
- Add estimates, cancellation, sample repeats, baseline comparison, and evidence report.

### Phase 3 — Build console and release gate

- Run named Quick, Prebuild, Full check, and Package profiles.
- Capture commands/logs/results, support stage retry and isolated package builds.
- Add one-click release readiness report and optional artifact bundle.

### Phase 4 — Scaled corpus analytics

- Upgrade corpus labels/coverage and stratified sampling.
- Add resumable 10k jobs, model concurrency limited by inference governor, per-question stage results, throughput/cost estimates, and statistically careful comparisons.
- Keep the 10k run as broad diagnostics, separate from deterministic prebuild and curated release gates.

## Acceptance criteria for a high-quality first release

1. A developer can open the app and run the exact prebuild gate without opening a terminal; UI shows test count/files, stage status, output, duration, and exit code.
2. A deterministic simulated failure scenario is reproducible from a saved run; replaying its recorded model messages requires no provider call and yields the same routing/tool/oracle results.
3. A real-model smoke run is clearly labeled, uses a disposable fixture workspace, records the selected provider/model, and requires no writes to the user’s project.
4. One explicit edit request is checked against expected intent, permitted scope, a relevant nonempty diff, and verification evidence; model text saying “done” cannot pass alone.
5. Each failure is categorized by stage and can be traced to its exact request, route, model response, tool result, recovery decision, and oracle.
6. The report says “incomplete” when a stage is skipped/cancelled and never treats simulated output as real-model validation.
7. Artifacts are local by default, redact secrets, and include no source content unless the developer explicitly opts in.
8. The 10,000-question test report states whether it is mocked or real-model, whether it used production chat intake, what oracle it applies, and what that result can and cannot establish.

## Downstream model instructions

- Inspect the current working-tree diff before changing any related files; this repository already has user changes in the agent, eval, model, and retrieval paths.
- Do not claim that tests were run unless they were actually executed; report exact commands and outcomes.
- Do not replace provider transport with a fake in live mode, or accidentally call a provider in simulated mode.
- Do not test agent edits against the user's selected project by default; use disposable fixtures and explicit user approvals for any real workspace writes.
- Reuse production orchestration rather than creating a parallel “test-only” chat implementation.
- Keep these concerns separate in result data: route correctness, model protocol, tool execution, workspace effects, verification, and final response quality.
