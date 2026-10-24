# Build & Agent Diagnostics — first increment

Implementation guide for the diagnostics runtime. The current system map is in [ARCHITECTURE.md](ARCHITECTURE.md); remaining work and acceptance criteria are in [RECOMMENDATIONS.md](RECOMMENDATIONS.md). Reviewed against version 0.4.15 on 2026-10-24.

## What ships

| Area | Status |
| --- | --- |
| Phase 0: per-task eval timeout, abort cleanup, distinct `timed_out` / `cancelled` results | Done |
| Phase 0: fixture/check path containment (schema + filesystem boundary) | Done |
| Phase 0: corpus runner labeled “real-model corpus run” with path and oracle limits | Done |
| Phase 0: simulated vs real-model label on every diagnostics result | Done |
| Phase 1: shared chat-turn orchestration seam, scripted model adapter, curated simulated scenarios | Done |
| Phase 1: per-case timeline, failure stage/category, JSON + Markdown export, replay of recorded responses | Done |
| Phase 2: real-model smoke on the same curated cases (opt-in, isolated) | Basic: single model, no repeats, baselines, or cost estimates |
| Phase 3: build console (run typecheck/test/lint/build stages from the app) | Deferred |
| Build gate: diagnostics, sandbox, and scripted `chat:stream` tests run in `test:agents` (`prebuild`) | Done |
| Effect refusals enforced by the scope at each service boundary, not by coordinator options alone | Done |

## Architecture

- **Shared chat turn** — `electron/main/services/chat-turn.ts`. The route → semantic intent → task contract → prompt → local model choice → outcome-evidence steps come out of `ipc/chat-stream.ts`, which now calls them. Diagnostics call the same functions plus `runAgentWithWorkspaceTools` and `reviewTaskOutcome`. Not exercised: Cloud Composer inline, delegation, approvals UI, project memory, task persistence, and renderer streaming.
- **Model transport seam** — `electron/main/services/model-transport.ts`. `streamModelChat` (`chat-runtime.ts`) routes to the adapter of the active diagnostics scope, which is an `AsyncLocalStorage` scope. Otherwise it calls `streamProviderChat`. Each caller tags its stage (`agent`, `route`, `intent`, `outcome`), so scripts answer each stage separately.
- **Adapters** — `debug-runs/model-adapters.ts`. `ScriptedModelAdapter` (scenario scripts or recorded replies) never calls a provider. `LiveModelAdapter` delegates to `streamProviderChat` and records hashes, plus text when capture is on.
- **Coordinator** — `debug-runs/coordinator.ts`. Builds a disposable `eris-diagnostics-*` fixture per case and runs the shared turn inside the scope, under a per-case deadline. It then evaluates the oracle, classifies the failure, and persists the case.
- **Oracle** — `debug-runs/oracle.ts`. Route, tool protocol, workspace effects, answer, blocked effects, and terminal state are separate checks. The earliest failing stage becomes the case failure. An answer that claims success never substitutes for a required diff.
- **Store/export** — `debug-runs/store.ts` and `debug-runs/export.ts`. Local only, under `<userData>/debug-runs/`: summary JSON, append-only case JSONL, and an optional replies JSONL; the newest 30 runs are kept. Exports are redacted and saved to a path the user picks; model replies are included only when the user opts in.
- **IPC/UI** — `ipc/debug-runs.ts`, plus `src/features/evals/DiagnosticsSection.tsx` inside the Evals panel. Every payload is validated with Zod in the main process, and run IDs are restricted to plain identifiers.
- **Scripted `chat:stream` case** — `tests/chat-stream-diagnostics.test.ts` runs the real `chat:stream` handler inside a simulated scope. It covers routing, task intake, the agent loop, tool execution, diffs, outcome review, chat-job status, and the command-approval IPC round trip. The test supplies the renderer (a fake sender) and the user's approval answer. No in-app runner uses this path yet.

## Invariants and where they are enforced

- **Simulated runs never call a provider.** The scope routes every model call to the scripted adapter. Simulated settings drop all connections and carry a non-serialized marker, so `streamProviderChat` refuses any simulated call that loses its scope. Tests mock both provider modules and assert zero calls.
- **Real-model runs are labeled and isolated.** They require `acknowledgeLiveCalls: true` plus a renderer confirmation, and use user-level settings only. They run in a temp fixture, never the selected workspace, and every result is labeled `REAL MODEL`.
- **No external effects, and replay grants no approvals.** `approveCommand`/`approveMcpTool` always deny. Inside a scope, these refuse at their own boundary and report a blocked effect, whatever options the caller passed:
  - `runWorkspaceCommand`, `runVerify`, `searchWeb`, and `openWebPage`.
  - MCP: `syncMcpRuntime` never connects, `listMcpTools`/`getMcpStatuses` return nothing, and `callMcpTool` refuses.
  - `generateImage`.
  - `enqueueBackgroundJob`. A persisted job would outlive the case's sandbox and run outside the scope.
  - Cloud Agents inline: `cloudInlineAvailable` and `runCloudAgentInline`.

  The coordinator also passes `mcp: 'off'` and `allowDelegate: false` and disables images, as a second layer. Replays therefore re-encounter every effect and are refused again.
- **Terminal states are distinct.** `task-deadline.ts` links run cancellation and a per-task timer and records which fired first. `drainUntilStopped` abandons a producer that ignores its signal.
- **Paths stay in the sandbox.** `SandboxPathSchema` rejects absolute, drive-qualified, traversal, and NUL paths. `sandbox-paths.ts` re-checks through real paths, which catches symlink escapes, and fixtures are validated in full before the first write.

## Regression coverage and remaining work

Earlier routing observations from the first diagnostics implementation are historical. Current task interpretation separates artifact, project applicability, obligations and effect constraints; the follow-up and live-review regression suites cover corrections added since that implementation. Do not reuse the removed review findings as current bugs without reproducing them against the checked-out source.

For the next work, use [RECOMMENDATIONS.md](RECOMMENDATIONS.md), especially REC-09 (desktop interaction coverage), REC-10 (independent quality evaluation), and REC-12 (model capabilities and context budgets). Eris-Dev's [live-model guide](ERIS-DEV-LIVE-MODELS.md) describes its separate opted-in inference path.

The simulated diagnostics suite, real-model smoke runs, request-boundary corpus captures, Eris-Dev deliverable checks, and actual desktop installation tests establish different properties. Preserve their labels and exclusions in every report. A successful runtime or request-invariant result is not an answer-quality score.
