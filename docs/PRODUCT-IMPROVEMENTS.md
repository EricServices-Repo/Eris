# Eris Product Improvement Backlog

**Purpose:** Implementation-ready review of the Eris AI IDE codebase for future coding models. This document records product and architecture improvements; it does not implement them.

**Review date:** 2026-10-21  
**Repository:** `/Users/ericembling/Documents/EricServices-IDE`  
**Reviewed version:** `0.4.6` (working tree contains uncommitted changes; treat findings against the reviewed checkout, not as a clean release snapshot).

## Executive summary

Eris already has substantial foundations: intent classification, task contracts, tool schemas, workspace indexing, a deterministic agent workflow, recovery, evals, persisted run activity, local models, and a rich desktop IDE. The core product gap is not a lack of agent personas. It is that correctness depends on several separately implemented interpretation and execution layers agreeing about the user's intended outcome. A routing fallback can change the task from “edit” to “plan”; an agent can then successfully complete the wrong contract. Tool protocol failures can cause loops; recovery can change the agent without changing the weak model or repairing the failed call. The UI shows activity, but the strongest user-facing truth needs to be “what changed, what was checked, and what is incomplete.”

Prioritize the P0s below before expanding agent roles or adding more prompt text. Then invest in eval quality and traceability so changes to routing, tool formats, context, and models can be judged against real user tasks.

## Evidence and review limits

- The checkout has existing uncommitted edits across agent, retrieval, model, and build files. Preserve those edits. Re-review the current diff before implementing backlog items that touch those files.
- A saved prior run referenced in the project history demonstrated an edit request stalling on malformed `read_file`/`write_file` arguments, repeatedly targeting a README, and ending incomplete. This is useful incident evidence, not a fresh reproduction against 0.4.6.
- Claude Code advisor was invoked through its bundled companion as required by its skill, but it refused to inspect this checkout because Claude Code still reports the repository as untrusted and requires a manual trust acceptance. This backlog is based on local source inspection.
- This was a read-only product review. No test suite was run in this pass.

## Prioritization

- **P0:** Risks the central promise (correctly implementing a requested code change), task integrity, or user trust.
- **P1:** High-value reliability, workflow, or latency improvement that materially improves daily use.
- **P2:** Product quality, breadth, discoverability, or maintainability improvements.
- **Size:** S (1–2 days), M (3–5 days), L (1–2 weeks), XL (multi-week; split into milestones). Estimates are relative engineering sizes, not calendar promises.

## P0 — Correct task intent and execution

### 1. Preserve explicit edit intent when semantic routing is uncertain

**Observed issue:** `resolveTaskIntent` returns `plan` when its inference fails or does not meet confidence for an explicitly classified edit (`electron/main/services/task-resolver.ts:95-110,122`). The caller in `electron/main/ipc/chat-stream.ts:208-260` replans when the semantic intent differs, then builds the task contract from that new plan. Therefore a clear edit request can become a read-only plan because a secondary resolver timed out, returned invalid JSON, or had low confidence. This is a direct route to the observed behavior where the agent recommends source changes instead of making them.

**Design:** Treat deterministic intent as the source of truth when the semantic resolver has no high-confidence correction. A model may refine ambiguity but should not demote an explicit imperative edit. Preserve an explicit “needs clarification” state for genuinely ambiguous asks rather than converting them to read-only silently. Record both initial and resolved intent plus the reason for any override in the route trace.

**Implementation areas:** `electron/main/services/task-resolver.ts`; caller/replanning in `electron/main/ipc/chat-stream.ts`; intent checks and route tests in `electron/main/services/chat-router.ts` and `tests/task-meaning.test.ts` / `tests/chat-stream.test.ts`.

**Acceptance criteria:**

- “Add authentication to this project”, “code those changes”, and “fix this bug” remain `edit` if semantic inference times out, throws, returns malformed JSON, or has confidence below 0.8.
- A question such as “how would I add authentication?” remains read-only unless the user explicitly requests implementation.
- The generated `TaskContract.deliverable` and `authority.edit` match the chosen intent.
- Tests cover the resolver success, low-confidence, timeout, malformed-output, and abort paths.

**Priority/size:** P0 / M.

### 2. Make outcome contracts match actual requested work and gate success honestly

**Observed issue:** The workflow tracks source reads, mutations, and verification (`electron/main/services/agent/workflow.ts:34-44,75-130`), which is a strong base. However, verification may be accepted as `skipped` after code mutation (`:119-128`), and the contract infers mutation partly from `TurnPlan`/goal. Task contracts and workflow contracts can diverge. A user may see “done” although the source changed without an applicable check, or may get a false failure when the requested task is deliberately non-code.

**Design:** Define one canonical outcome contract from the normalized user request and task contract. Explicitly model deliverable kinds (patch, explanation, review, plan, command result, artifact) and required evidence per kind. Verification should be “passed,” “not applicable with reason,” or “failed”; “skipped” must not be equivalent to success for code changes. Preserve partial completion as a first-class terminal state.

**Implementation areas:** `electron/main/services/agent/workflow.ts`; task contract construction in `src/shared/task-contract.ts` and `electron/main/ipc/chat-stream.ts`; semantic outcome review in `electron/main/services/task-outcome.ts`.

**Acceptance criteria:**

- A patch request cannot reach a successful terminal state without a verified workspace mutation and either a passing relevant check or a visible, justified “verification unavailable” state.
- Review/plan/answer requests do not acquire mutation requirements.
- Contract values are visible in trace and persisted with the run.
- Tests include “no diff,” “wrong files changed,” “check failed,” “check skipped with reason,” and non-code deliverables.

**Priority/size:** P0 / L.

### 3. Replace agent-name handoffs with capability- and failure-aware recovery

**Observed issue:** Mid-run adaptation selects an orchestrator or coder by role (`electron/main/services/agent/mid-run-adapt.ts:28-85`) and stops adapting after a reroute. The incident showed that a reroute could retain the same local model and the same malformed tool-call pattern. Changing the persona does not fix a provider grammar failure, bad arguments, missing context, or an unsuitable model.

**Design:** Recovery should classify the failure before choosing an action: malformed call → schema-constrained retry with a corrected example; unavailable tool → discover a supported equivalent; wrong target → refresh project resolution/retrieval; low capability → escalate model if an appropriate model exists; repeated failure → stop with a precise blocked state. Treat agent identity, model, tool protocol, context, and task plan as independent recovery dimensions. Use a bounded policy with explicit reason codes and no blind repeat.

**Implementation areas:** `electron/main/services/agent/mid-run-adapt.ts`, `recovery.ts`, `loop.ts`, `stream.ts`, tool schema/validation, and persisted job events.

**Acceptance criteria:**

- Same invalid tool call is never retried unchanged after a validation failure.
- Recovery records failure class, action, changed dimensions, and result.
- If the agent/model/tool protocol is unchanged and the same failure recurs, the run stops with a user-readable blocker instead of consuming the run budget.
- Tests inject tool schema errors, provider errors, retrieval misses, verification failures, and cancellation.

**Priority/size:** P0 / L.

### 4. Make project targeting explicit and guard every mutation against target drift

**Observed issue:** The system has a task contract that includes project scope and the activity surface exposes project root and permissions (`src/features/agents/ChatAgentActivity.tsx:67-91`). Yet the incident showed the agent inspecting metadata/README instead of the intended application. A sibling-folder or wrong-workspace mistake can produce plausible but useless work.

**Design:** Resolve the target project once at intake, show it before execution, and carry an immutable canonical workspace identity through all delegated work and tools. Require a short source-grounded preflight for edit tasks: project root, likely entry files, existing stack, and expected files to change. If the target is ambiguous, ask one focused question before writes. Before applying changes, assert every target path resolves under the same canonical root.

**Implementation areas:** `src/shared/task-contract.ts`, `electron/main/ipc/chat-stream.ts:242-260`, `electron/main/services/agent/project-target.ts`, `tool-gateway.ts`, workspace FS utilities, and chat activity UI.

**Acceptance criteria:**

- A task trace shows canonical root and target-resolution evidence.
- A mutation cannot escape the selected project or land in a sibling project.
- Tests cover symlink paths, missing workspace, multiple projects, and project changes during a run.

**Priority/size:** P0 / L.

## P1 — Make agent execution reliable, fast, and inspectable

### 5. Define a versioned, provider-neutral tool-call protocol and strict parser

**Observed issue:** Local model tool calls use text-envelope parsing and provider-native formats through separate paths. `pushToolEnvelope` falls back to treating all top-level fields except `name` as arguments when `arguments` is not an object (`electron/main/services/agent/tool-parsing.ts:94-107`); this preserves malformed calls but can turn a protocol error into confusing downstream validation errors. Corrective instructions are currently repeated in prompts (`context-compiler.ts:20-25`).

**Design:** Define a versioned envelope with a single canonical shape (`name`, object-valued `arguments`, optional call id). Validate envelope shape and tool-specific schema before dispatch. Keep provider adapters responsible for converting native calls to this shape. Reject ambiguous legacy envelopes with a repair hint naming the expected field, and redact/truncate oversized arguments. Add protocol version and adapter name to telemetry.

**Acceptance criteria:** Fuzz-tested parser handles malformed JSON, fences, multiple calls, string-valued arguments, unknown names, duplicate calls, and truncated output without executing unintended tools. Contract tests run every provider adapter against the same fixtures.

**Priority/size:** P1 / L.

### 6. Add end-to-end agent tracing with a single inspectable run timeline

**Observed issue:** `ChatAgentActivity` polls latest activity every two seconds (`src/features/agents/ChatAgentActivity.tsx:11-32`) and reconstructs route/delegation details from events (`:33-125`). Chat stream publishes route and delegation events (`electron/main/ipc/chat-stream.ts:384,415,852`). These are helpful, but model request/response boundaries, context inclusion, tool schema, retries, recovery choices, verification evidence, and timing are not yet presented as one coherent trace.

**Design:** Persist a structured event timeline keyed by chat/thread/run: intake → route → task contract → project evidence → model call (model/provider/latency/tokens/context digest) → tool call and result → recovery → verification → final outcome. Stream incremental events to UI instead of polling latest state. Add export as JSONL for defect reports with secret/PII redaction. Include a “why this route?” explanation and a visible completion evidence checklist.

**Acceptance criteria:** A user can diagnose “wrong agent/model,” “wrong files,” “tool failed,” and “why says done?” from a single exported trace. Trace survives panel switch/app renderer reload and does not include API secrets or full sensitive file contents.

**Priority/size:** P1 / L.

### 7. Replace generic chat corpus pass rates with quality-scored, reproducible evaluations

**Observed issue:** Eval checks are useful but largely explicit file/answer/tool/step conditions (`electron/main/services/eval-runner.ts:96-189`). A suite runs task/model/repeat jobs serially and stores only the most recent 400 raw results (`:350-425`, `electron/main/services/eval-store.ts:7-45`). Scoreboard buckets by model and intent, with simple pass rate and averages (`eval-store.ts:47-103`). The 10,000-question corpus uses `planChatTurn`, then builds an `EvalTask` and calls `runEvalTask` directly (`electron/main/services/corpus-debug-runner.ts:284-315`). That exercises routing and the agent runner in an isolated fixture, but it does not traverse the complete production `chat-stream` intake, semantic intent resolver, task persistence, prompt construction, streaming IPC, renderer state, and final outcome path. Corpus UI calls it a “real-model smoke test” and says it uses normal routing (`src/features/evals/EvalsPanel.tsx:131-138`), so clarify precisely which production layers it does and does not cover. A pass rate alone can hide regressions in intent accuracy, edits, grounding, or verification.

**Design:** Use a layered eval set: deterministic intent/tool/workspace assertions; fixture-based quality rubrics; pairwise regression comparisons; repeated sampling for nondeterministic models; and a small curated golden set for release gating. Store run manifest (app version, prompt/protocol version, model/provider, settings, corpus hash, commit), full per-question outcome, failure category, changed files, route accuracy, tool validity, check result, latency distribution, and tokens. Show confidence intervals and compare against baseline.

**Acceptance criteria:** A run can be reproduced from its manifest; changed routing, tool validity, mutation success, evidence grounding, and latency are separately reported; partial/cancelled runs are never labeled as complete; a release report identifies regressions by question and stage. Maintain both a fast isolated agent eval and a smaller end-to-end suite that traverses the same intake/execution/event path as a real chat. Label corpus runs as simulated workspace tasks rather than implying they test the user's current project or every production renderer path.

**Priority/size:** P1 / XL (split corpus manifest/storage, scoring, then UI).

### 8. Make retrieval incremental, language-aware, and explainable

**Observed issue:** Retrieval ranks with path terms, hash embeddings, and simple symbol hits, then falls back to `rg` (`electron/main/services/workspace-search.ts:372-507`). Sync retrieval walks up to 5,000 files and reads file contents (`:315-365`). Index and extension allowlists are broad but language-specific symbol extraction and evidence coverage can be uneven, especially in dynamic languages. The previous run’s project showed the cost of retrieving metadata or README rather than actual app entry files.

**Design:** Use file-watcher-driven incremental indexing; language-aware AST/LSP symbols where available; project manifests/framework conventions; route-specific retrieval templates; and diversity constraints so retrieval includes relevant implementation, tests, and config. Report retrieval evidence (matched terms, symbols, score components, excluded paths) and ask the model to confirm candidate relevance before edits. Keep metadata/config exclusions configurable and observable.

**Acceptance criteria:** Benchmark Recall@k and source-file coverage on JS/TS, Python, PHP, Rust, and Swift fixtures; warm retrieval is below a defined latency budget for a large repo; edits to a file invalidate related caches promptly; each edit task’s preflight shows relevant source and test candidates.

**Priority/size:** P1 / XL.

### 9. Use event-driven state updates and backpressure for streaming chat

**Observed issue:** Chat IPC already coalesces thinking/answer chunks at 40 ms (`electron/main/ipc/chat-stream.ts:298-320`), while activity uses a two-second polling loop. The session hook is large and owns many stream and persistence concerns (`src/hooks/useChatSession.ts`, 1,026 lines). This can cause redundant work, stale UI state, hard-to-test races, and memory issues on long transcripts.

**Design:** Use a typed event subscription with per-request sequence numbers, idempotent reducers, explicit terminal events, and bounded buffers. Separate transport, stream state, transcript persistence, and UI projections into focused modules. Apply backpressure/coalescing at the transport boundary and virtualize long chat histories consistently. Restore from durable job checkpoints after renderer reconnection.

**Acceptance criteria:** No lost/duplicated answer chunks across app focus changes or renderer reload; memory remains bounded on long streams; cancellation and route changes have deterministic terminal states; activity updates appear without polling delay.

**Priority/size:** P1 / L.

### 10. Make local-model selection and runtime fit explainable before a task starts

**Observed issue:** Context budgets cap non-builtin models and derive builtin budgets from VRAM/context configuration (`electron/main/services/agent/context-budget.ts:4-19`). The product supports local models and hardware-aware fit, but model capability, context, tool-call reliability, cold start, memory, and expected task suitability are separate concerns.

**Design:** Add a preflight model card that estimates fit and expected behavior using available GPU/RAM, quantization, context window, tool protocol support, and measured local latency/tool success. Distinguish “can load” from “recommended for editing.” Warm models opportunistically after route selection; avoid router-model cold-start delays for deterministic intents. Provide a suggested smaller/faster or larger/stronger model with a clear reason.

**Acceptance criteria:** Before a large request, UI shows estimated memory/context fit and known tool-support limits; no silent context truncation; first-token and warm-start latency are measured; selecting a tool-poor local model degrades gracefully with explicit limitations.

**Priority/size:** P1 / L.

### 11. Make context assembly budget-aware, relevance-ranked, and reproducible

**Observed issue:** Task context compiler pins task and instructions, then includes project/retrieval context under a 55% character-based allocation (`electron/main/services/agent/context-compiler.ts:10-55`). Context budget is in estimated tokens, while the compiler uses character counts. Compaction estimates tokens as roughly chars/3 (`electron/main/services/agent/compaction.ts:31-37`) and shortens old tool output (`:44-89`). These heuristics risk wasting scarce local-model context or cutting important evidence.

**Design:** Prefer tokenizer-aware accounting per model; rank optional blocks by task relevance and provenance; preserve exact source-line excerpts for files already read; summarize stale tool output into structured facts with links back to source; display a context manifest with included, truncated, and omitted items. Make compaction deterministic and testable against tasks requiring facts from early and late turns.

**Acceptance criteria:** Context never exceeds model limit with safety margin; contract/instructions are never silently truncated; relevant evidence survives compaction; trace export identifies every omitted or summarized block.

**Priority/size:** P1 / L.

### 12. Give delegated agents explicit contracts, shared evidence, and bounded authority

**Observed issue:** Delegation events are shown in UI (`src/features/agents/ChatAgentActivity.tsx:45-50,111-119`) and handoff supports orchestrator/specialist roles. The product experience needs strong guarantees that delegate results retain project root, user request, evidence, and permission ceiling; current role changes risk losing the actual error and duplicating work.

**Design:** Represent delegation as a typed subtask contract: goal, non-goals, files/evidence, allowed tools, expected output schema, done criteria, parent run ID, and deadline/budget. Require delegates to return evidence-linked findings or patch references. Coordinator validates and merges outputs, deduplicates overlapping tasks, and retains a human-readable trace. Delegates cannot broaden authority.

**Acceptance criteria:** Tests prove scope and permissions cannot increase on handoff; duplicate subtasks are prevented; parent sees delegate status, evidence, errors, and cancellation; specialist output with no evidence cannot be marked complete.

**Priority/size:** P1 / L.

### 13. Replace opaque waiting with useful progress and honest partial outcomes

**Observed issue:** Runtime has statuses and tool events, and loop has logic to stop repeated calls (`electron/main/services/agent/loop.ts:1835-1935`). Users still face long waits and can receive an incomplete result after recovery stops. A run must communicate whether it is thinking, waiting on a provider, editing, verifying, blocked, or done.

**Design:** Standardize activity states and display elapsed stage time, current objective, current file/command, last successful action, and the next planned action. Add “waiting on model” vs “tool executing” distinction, cancel, and safe pause where supported. Final summary should list changed files, checks run/results, unresolved items, and recovery failures; never summarize a tool log as successful work.

**Acceptance criteria:** Every run has one terminal status; incomplete runs visibly name what remains; long model calls show elapsed latency and cancel state; UI labels match the persisted workflow state.

**Priority/size:** P1 / M.

## P2 — Improve product usability and development quality

### 14. Add a guided first-run path based on a real project task

**Opportunity:** The product has onboarding/setup UI and many model, GPU, composer, and image settings. New users need to understand workspace selection, trust, model readiness, chat modes, and whether Eris can write code without exploring many settings panels.

**Design:** Guided setup: choose/open a project → trust and inspect project → run a harmless read-only question → choose a model based on local hardware/provider → make a small proposed edit in a disposable sample or user-selected file → review diff and verification. Explain Ask vs Agent and approvals at the point of use.

**Acceptance criteria:** New-user completion funnel measures time to first grounded answer and first verified edit; setup catches missing model/permissions before prompt submission; user can skip or revisit each step.

**Priority/size:** P2 / L.

### 15. Build a proper changes review and rollback workflow around agent edits

**Opportunity:** AI IDE trust depends on inspecting and reverting exact changes. The project includes diff review and checkpoint mechanisms, but the user should have consistent file-level and hunk-level review, restore, and provenance.

**Design:** Every agent mutation should attach to a run/checkpoint; show before/after diff, reason, originating tool call, and verification. Allow accept/reject per file/hunk and restore to pre-run state without overwriting unrelated user edits. Detect if file changed externally between read and apply and require a fresh read/merge.

**Acceptance criteria:** A user can revert only a run’s changes; unrelated edits remain untouched; mutation provenance links to the task and tool event; stale read-before-write is surfaced as a merge conflict.

**Priority/size:** P2 / L.

### 16. Create a task-aware verification planner

**Opportunity:** Verification is represented in workflow/outcome contracts, but project test discovery and relevance vary by stack. Running an entire test suite may be slow; running no test undermines confidence.

**Design:** Resolve package/build/test configuration, changed files, and affected tests; select the smallest reliable check first, then broaden when cheap or when the local check fails. Report “not found” separately from “not run.” Track command exit code, duration, output tail, and environment.

**Acceptance criteria:** For fixtures, planner chooses the expected targeted test/typecheck/lint; detects missing scripts; never claims a check passed without the exact observed exit code; command approval applies before effects.

**Priority/size:** P2 / L.

### 17. Make search and code navigation first-class context tools

**Opportunity:** The agent has workspace search/retrieval, but user-driven IDE workflows need explicit navigation to symbol definitions/references, diagnostics, and test links rather than asking a model to infer everything from text search.

**Design:** Expose LSP-backed “definition,” “references,” “diagnostics,” “outline,” and “related tests” tools where the language server is available, with resilient textual fallbacks. Link citations in agent answers to open exact file/line in the editor. Reuse current editor selection and open tabs as ranked context, respecting privacy/workspace scope.

**Acceptance criteria:** Symbol navigation works for supported language servers; fallback behavior is transparent; citations open the stated file and line; tool traces identify source.

**Priority/size:** P2 / XL.

### 18. Modularize high-complexity renderer and agent-loop responsibilities

**Observed issue:** Several central UI/runtime files are large: `src/App.tsx` (1,552 lines), `src/features/chat/ChatPanel.tsx` (1,184), `src/hooks/useChatSession.ts` (1,026), and `electron/main/services/agent/loop.ts` (multi-thousand-line orchestration). This increases change coupling and makes agent reliability regressions hard to isolate.

**Design:** Extract by behavior, not arbitrary line count: chat transport reducer, history persistence, composer/attachment UI, route explanation, activity trace; agent lifecycle, tool execution, recovery policy, verification, and outcome reporting. Define typed module boundaries and test each state transition without loading Electron UI/provider runtime.

**Acceptance criteria:** Each module has a single documented responsibility and public types; no behavior change in extraction PRs; targeted unit tests exercise reducers/policies; chat state is no longer duplicated between App and hooks.

**Priority/size:** P2 / XL.

### 19. Make quality telemetry private-by-default, useful, and actionable

**Opportunity:** Chat stream has opt-in agent outcome telemetry (`electron/main/ipc/chat-stream.ts:328-330`), and eval data is stored locally. Product teams need to identify common failure stages without collecting user code or prompts by default.

**Design:** Keep telemetry opt-in and local-first. Record aggregate stage timings, intent, model/provider ID (not credentials), tool schema-validity, recovery count, completion state, verification state, and anonymized error code. Allow user to preview/export a redacted issue bundle. Explain retention and provide clear delete controls.

**Acceptance criteria:** No source content, prompt text, secrets, or absolute workspace paths leave the device unless user explicitly exports; opt-out is enforced at the event producer; telemetry explains actionable error categories.

**Priority/size:** P2 / M.

### 20. Expand language and project-type support through explicit capability matrices

**Opportunity:** Search currently includes many language file extensions (`electron/main/services/workspace-search.ts:10-40`), but project discovery, symbols, testing, and editing reliability are not uniform. Users need to know what Eris can reliably do in each stack.

**Design:** Maintain capability profiles for languages/frameworks: parse/index support, navigation, test discovery, lint/typecheck commands, build/test sandbox support, and known limitations. Use project manifests and lockfiles to infer stack. Use this profile to select retrieval, tools, and verification and to present accurate setup guidance.

**Acceptance criteria:** Representative fixtures for supported stacks assert detected language/framework, entry files, test command, and expected symbol support; unsupported cases degrade honestly and do not invent commands.

**Priority/size:** P2 / L.

### 21. Treat local image generation as a managed workload, not a normal chat call

**Opportunity:** Eris already has local image model and generation capabilities. Model loading/generation can contend heavily for GPU memory and stall the IDE.

**Design:** Put image generation behind a resource scheduler with preflight VRAM/RAM estimates, cancellable worker isolation, progress, concurrency limits, and automatic unload/cleanup. Keep model download, model selection, and tool capability distinct. Ensure text-agent work remains responsive while image generation runs.

**Acceptance criteria:** Insufficient-resource cases are rejected before inference with a usable explanation; cancellation releases worker/model resources; image jobs do not freeze chat/editor; logs capture resource estimates and observed peak use.

**Priority/size:** P2 / L.

## Additional confirmed P1 findings

### 22. Enforce evaluation fixture and check-path boundaries

**Confirmed security concern:** Workspace eval definitions are parsed from `.eris/evals.json` and `.eris/evals/*.json` (`electron/main/services/eval-tasks.ts:15-37,61-76`). The schema accepts arbitrary strings as fixture paths (`src/shared/evals.ts:33-44`). `materializeEvalTask` builds file targets using `join(dest, rel)` and writes them without checking that the resolved path remains under `dest` (`electron/main/services/eval-runner.ts:44-51`). A fixture entry such as `../../some-file` can escape the intended disposable sandbox when that workspace eval is run. Eval check paths also use `join(workspacePath, check.path)` without containment validation (`eval-runner.ts:104-129`).

**Design:** Normalize and validate every fixture/check path at schema ingestion and again at the filesystem boundary. Reject absolute paths, drive prefixes, `..` traversal, NUL bytes, and symlink escapes. Resolve through real paths where a target exists. Do not partially execute a task if any fixture path is invalid. Show the offending eval id/path to the user and keep the invalid task out of the run list.

**Acceptance criteria:** Traversal, absolute, mixed-separator, Windows drive, and symlink escape fixtures are rejected on macOS and Windows; no file outside the eval temp root changes; check reads are restricted to the sandbox; valid nested paths still work.

**Priority/size:** P0 / M (security boundary; fix before broadening workspace-authored eval usage).

### 23. Enforce per-task eval timeout and isolate lifecycle cleanup

**Confirmed defect:** `EvalTaskSchema` exposes `timeoutMs` (`src/shared/evals.ts:33-44`), but `runEvalTask` forwards the external cancellation signal into the agent and never applies the task timeout (`electron/main/services/eval-runner.ts:230-301`). The declared timeout therefore does not bound agent execution. The `command` check has its own 60-second timeout (`eval-runner.ts:200-227`), but that does not bound the model/agent portion.

**Design:** Derive a child `AbortController` for each task, link it to the suite-level signal, and schedule abort at `task.timeoutMs`. Ensure timeout, cancellation, and provider errors produce distinct terminal result codes; always clean up child timers, worker/model resources, and temp directories. Report timeout in the result rather than conflating it with user cancellation.

**Acceptance criteria:** A deliberately non-terminating mock agent ends within `timeoutMs` plus a small scheduling margin; user cancellation remains distinguishable; temp sandboxes and inference leases are released on timeout; serialized eval result carries a stable `timed_out` failure category.

**Priority/size:** P1 / M.

### 24. Close the eval quality feedback loop without letting scores silently control routing

**Opportunity:** `bestEvalModelForIntent` chooses a model using only success rate and minimum sample count (`electron/main/services/eval-store.ts:87-103`). This is useful for exploration, but success can be affected by easy tasks, fixture mix, prompt version, model availability, and one-off nondeterminism. Any learned route should be explainable and reversible.

**Design:** Version task suites and scoring policy; require minimum coverage across task categories; use confidence-aware thresholds; store route policy snapshot in the run; expose why an eval-informed model was preferred and let the user inspect/disable learned routing. Never allow old results from another prompt/protocol/corpus version to silently tune current routing.

**Acceptance criteria:** Model recommendations identify sample count, suite version, category coverage, uncertainty, and last evaluation date; incompatible eval runs are excluded; routing decisions retain deterministic fallback and show the selected model’s evidence.

**Priority/size:** P1 / M.

## Additional P2 recommendation

### 25. Make workspace-authored evals discoverable and safe to curate

**Opportunity:** Workspace eval tasks are loaded from hidden `.eris` locations (`electron/main/services/eval-tasks.ts:15-37`) while the current product includes corpus and suite controls in one Evals panel. Product teams need a clear creation/review path so eval quality is not limited to a small built-in task set.

**Design:** Add an eval authoring flow with fixture tree preview, prompt/criteria editor, path validation, test-run preview, and suite metadata. Offer seeded templates by intent and language. Show whether each task tests answer quality, routing, tool protocol, mutation, or verification. Keep eval tasks version-controlled when the user chooses, but strip workspace execution permissions unless explicitly authorized.

**Acceptance criteria:** A user can create and validate a task without hand-editing JSON; malformed or unsafe fixture paths are blocked before execution; saved task metadata indicates coverage category and intended assertion; eval run preview states which commands can execute.

**Priority/size:** P2 / M.

## Additional architecture-wide product recommendations

### Keep user intent, route decision, execution policy, and result separate

The request should be normalized once into a stable user goal and deliverable. Routing then selects an agent/model; policy authorizes tools; workflow validates actual outcome. Today these concerns are present but can be recalculated in sequence: `planChatTurn` runs in `chat-stream.ts`, `resolveTaskIntent` can alter intent, `planChatTurn` may run again, and `createTaskContract` then derives scope/authority. The P0 intent downgrade demonstrates why these steps need a canonical immutable task envelope. Any later change should be an explicit, traced correction with a reason, never an implicit reinterpretation.

### Make failure categories the shared language of product, telemetry, recovery, and evals

Adopt stable categories such as `intent_mismatch`, `wrong_workspace`, `no_source_evidence`, `tool_schema_invalid`, `tool_unavailable`, `provider_timeout`, `context_overflow`, `mutation_not_applied`, `verification_missing`, `verification_failed`, `user_cancelled`, and `partial_completion`. Use the same category in chat UI, exported issue bundles, eval checks, and recovery policy. This prevents the product from treating all failures as generic model weakness and gives future models a reliable place to start debugging.

### Define user-visible service objectives for the AI IDE

Track quality and latency by route and model: time to first useful event; time to first valid tool call; time to first mutation; percent of explicit edit tasks that create a relevant diff; percent of diffs with successful verification; wrong-workspace rate; malformed tool-call rate; retry count; recovery success rate; cancellation-to-stop latency; and crash/hang rates during local inference. Set targets only after collecting a representative local baseline, and expose the metrics in a debug view that can be exported with user consent.

### Treat app responsiveness and background work as product features

Indexing, image generation, model loading, eval suites, and chat inference all compete for CPU, RAM, GPU, disk, and user attention. Use a single resource scheduler with workload priority, cancellation, queue visibility, memory estimates, and pause/resume where safe. Distinguish a busy model from a frozen UI. Keep renderer work small and ensure expensive filesystem scans run off the main thread with progress and cancellation.

## Recommended implementation sequence

1. **Correct edit intent and outcome contract** (items 1–2). This closes the highest-impact path where the product returns recommendations instead of code changes.
2. **Failure-aware recovery and project targeting** (items 3–4). This reduces repeated invalid calls and wrong-project edits.
3. **Run timeline and protocol testability** (items 5–6). This makes failures diagnosable and creates stable interfaces for local models.
4. **Evaluation redesign** (item 7). Establish a trustworthy baseline before broader behavior changes.
5. **Retrieval/context/model preflight** (items 8, 10, 11). Improve what the selected model sees and whether it is suitable.
6. **Streaming, delegation, progress, review/rollback** (items 9, 12, 13, 15). Make longer tasks feel controlled and safe.
7. **First-run, verification planner, navigation, modularization, telemetry, stack profiles, image workload scheduling** (items 14, 16–21).

## Cross-cutting implementation rules for downstream models

- Preserve user changes already present in the working tree; inspect `git diff` before editing.
- Every routing or tool-protocol change must have deterministic regression tests for ambiguous phrasing, explicit implementation requests, malformed provider output, and provider timeout.
- Do not mark an edit complete because a plan was produced, a tool was attempted, or a file was merely listed. Verify the expected artifact exists and inspect the resulting diff.
- Prefer structured evidence and typed state over adding more free-form prompt instructions.
- Keep model/provider output untrusted. Validate tool name, schema, workspace path, permission ceiling, and command policy at the execution boundary.
- Surface partial or failed work honestly; never fabricate tests or claim an unobserved command passed.
- Measure task success by the requested deliverable and evidence, not agent activity volume or token output.
