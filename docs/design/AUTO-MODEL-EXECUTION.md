# Automatic model execution and recovery

Originally implemented for GitHub issues #268–274. Coordinator/intake behavior updated on 2026-11-06 against integrated main `067470e` (v0.6.16). Model-ranking and transition policies are retained. This is source documentation, not a new release or hardware qualification claim.

## User contract

Agent Auto chooses a role. Model policy is separate:

- **Fixed** keeps the selected execution model. Role recovery does not replace it.
- **Auto-local** admits native GGUFs and actual loopback model endpoints. A LAN endpoint remains remote even if explicitly approved to receive recall.
- **Auto-any** permits configured remote endpoints as well as local workers. Cloud Composer additionally requires the Agent/workspace execution path.
- Persisted legacy `auto` follows the routing profile and cloud preference in Settings. Catalog refresh retains an explicit automatic selection. Existing manual selections are not migrated silently.

An explicit per-agent model overrides automatic ranking, becomes fixed for recovery, and must satisfy Auto-local's locality boundary. A conflict blocks with a corrective explanation rather than silently exporting the request.

## Candidate admission and ranking

`auto-model-policy.ts` rebuilds the candidate pool for every selection and recovery. This observes changed readiness, URLs, profiles and available memory without an eligibility cache. Native workers need known weight size and estimated context headroom, or an adequate measured resident allocation. Non-chat files, declared intent/tool incompatibility, unavailable weights and inadequate context are excluded. Connected model readiness follows the existing optimistic persisted-catalog contract; an enabled entry is not proof of current server reachability.

Scores are applied only after eligibility filtering. Versioned telemetry wins when sufficient evidence exists, then evaluation results; otherwise deterministic task specialization and resident-model heuristics decide. File size is an admission estimate, never a quality score. Name-based coding/general specialization and load costs are estimates, not measured capabilities or latency claims. Optional model-card routing capabilities can explicitly disallow unsupported intents/tools.

Production evidence is tied to the app/runtime routing version, local weight hash/stat identity, endpoint, context settings and tool protocol. It expires after 30 days; old unversioned records remain visible but do not drive production Auto. Replaced local files and changed endpoint/protocol configurations cannot inherit old scores. Provider-side changes behind the same remote model identifier cannot be detected without provider provenance. Successful non-mutating answers count as outcomes as well as successful edits.

## Coordinator and execution worker

The primary chat path calls `planChatTurn` with `skipModelRouter: true`. After historical reference binding, `resolveChatTurnContract` uses the initial plan's tool model for tool-requiring Agent requests, otherwise its chat model, for any necessary semantic interpretation. It does not automatically load Lite to classify every message. Production skips classifier inference for a cold native model or an automatic remote destination. Explicit file creation with resolved operands bypasses inference altogether.

Only an accepted semantic decision records `models.coordinator`. A route change may then select a different worker. The separate optional routing-hint path in `planChatTurn` can also record the model whose hint was actually used. Skipped, invalid and timed-out classification must not be reported as a successful coordinator handoff.

Model selection and model preparation are separate. Initial selection still occurs before complete intake. Model-window and native context preparation are deferred for blocked intake through `taskIntakeBlocked`, shared by desktop chat and Eris-Dev. Missing/ambiguous file lists and Agent-mode permission conflicts produce an explanation before execution inference. Ask-mode explanations remain eligible for a model call.

When the worker differs, the agent loop emits a model-handoff ledger entry and adaptation event, prepares the target, and compiles the original task for it. Tool-free stories use the chosen chat worker without acquiring edit authority. Coding, review and planning use the same selector. Inline child tasks select for their own intent under the inherited policy; fixed choices and explicit child-agent overrides retain precedence.

## Recovery transaction

The existing two-adaptation budget bounds recovery. The loop tracks attempted execution models and excludes them from subsequent selection. Recoverable repeated empty output/no progress/tool-format or verification failures may choose a distinct eligible local worker. Recovery deliberately does not transfer already-derived local execution state to a remote endpoint. Safety and permission refusals do not trigger model shopping. No available alternative records an explicit diagnostic with exclusion reasons.

An intake failure is not a worker failure. Resolve missing references and explicit capability conflicts before entering recovery. Requested work remains separate from effective permissions, and recovery cannot satisfy an outstanding patch merely by changing its response into a plan. The current implementation does not include a general failure-diagnosis engine or automatic contract-revision planner.

A transition occurs between completed streams/tool batches:

1. Revalidate policy, readiness and fit; reject a fixed selection change.
2. Check cancellation and release the old KV session.
3. Use the existing exclusive inference scheduler and serialized model load/dispose path to prepare the target. Native preparation receives the cancellation signal.
4. Read measured target capacity, rebuild worker instructions/tool protocol, and refresh the context budget.
5. Commit the execution plan and continue with the same task identity, authority, transcript, tool observations, checkpoints, journal and completed file changes.

A failed preparation does not commit the proposed worker or replay completed edits. It consumes bounded recovery budget and records the refusal. Cloud startup failures may select an eligible local worker under automatic policy; Fixed Full stays fixed, and a Cloud stream that already began workspace work stops rather than replaying operations. Direct child/background/debug runners exclude the Cloud-only adapter. Scripted diagnostics skip real allocation; a simulated request that loses its scripted scope is rejected before preparation. Live diagnostics continue through real admission.

## Final serialization and RAM eligibility

Server-window preparation is followed by reference validation and a fresh recall eligibility check before serialization. Native inference additionally calls `prepareMessages` after allocation while holding the inference lease. That callback revalidates task references and recall, releases a seeded session when evidence was revoked, then repacks against the measured allocation using the destination protocol. The dispatch inspector and token estimates describe the actual post-load payload.

This protects a source forgotten during loading from entering the worker request. Request-owned evidence scopes isolate unrelated leases. Current handoffs also have versioned evidence metadata, sealed source/execution origins, task-tree limits and structured child outcome receipts. These implemented foundations must be reused; broader task-capability ranking and per-obligation child assignment remain proposals. Canonical chat source history is not rewritten during a model transition.

## Qualification

The routing changes add `requested-work.test.ts` and extend `task-meaning.test.ts`, `agent-request-coherence.test.ts` and `chat-agent-smoke.test.ts`. They cover classifier bypass, reference failures, requested/effective state, actual file creation and abort-ignoring outcome evaluators. See [request execution validation](REQUEST-EXECUTION.md#validation-of-this-implementation) for the recorded source-build results and limits.

`auto-model-policy.test.ts` exercises eligible-pool ordering, locality before scoring, endpoint changes, fixed pins, non-chat/resource exclusions, residency and task specialization. `model-switching.test.ts` runs real chat planning and the real agent loop through scripted transport, captures Lite routing to another local story worker, makes actual edits in temporary workspaces after recovery, and verifies an earlier write is not replayed. It also covers transition capacity, cancellation, admission failure, refusal policy and lost diagnostic scopes.

`memory-dispatch.test.ts` revokes sources during mocked native/server preparation and captures the final adapter payload. These suites run in the agent build qualification profile. They are deterministic logic/transport tests, not live-model quality measurements, GPU certification or packaged Windows/macOS validation.

## Later handoff integration

Automatic model choice does not transfer the parent's RAM store to a child. Both child execution modes now share `handoffMessages`, while required inherited requirements and up to 12 constraints of 300 characters live in the canonical task. Optional summary remains cuttable. Background jobs preserve a dependent evidence scope while its parent lease lives; cancellation stops the subtree and discard waits up to 30 seconds before retaining an unfinished worktree. Model-switching acceptance must preserve these contracts and the run journal's `busy`/omission distinction.
