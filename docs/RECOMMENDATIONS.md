# Eris: next fixes

Reviewed **2026-10-24**, source baseline `6038e16dcdf58044bd5245294931005f3094e804`, version **0.4.15**. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the current implementation. This file supersedes the dated Markdown review backlogs. Implementation is now in the local `main` checkout. Statuses below distinguish source changes from deployment and live-platform acceptance; the baseline SHA identifies the reviewed source, not a new committed release.

Priorities: **P0** is a distribution/security boundary to address before another affected release; **P1** is the next reliability or capability work; **P2** is hardening after those boundaries are stable. A source-confirmed gap is distinguished from a validation gap. No paid/live quality baseline, production cloud deployment, credential rotation, Windows installation, GPU fault certification, or signed update installation was performed. A local packaged macOS smoke test and actual Electron process recovery probe passed.

## Fixes already present

Do not reopen these as missing features without a new regression:

- Task contract v2 separates artifact, destination, project applicability, obligations, constraints, and effect authority.
- Recommendation objects persist between turns; selected recommendations receive separate obligations and accounting. Prose parsing remains a fallback for older history.
- The tool gateway checks project paths and stale inspected files. Partial reads cannot authorize whole-file rewrites. Overlapping project mutations are serialized.
- Native tool-call/result history is validated; one-shot/session history and reply-budget behavior have regression coverage.
- Worker exit/error, deadlines, cancellation, and generation termination are separately represented. Runtime native failure does not automatically reload the same failing model in Electron main.
- Eris-Dev captures full deltas, records per-call termination, detects visibly broken deliverables, bounds repair/finalization, and labels export coverage. These checks do not grade answer correctness.
- The Windows snapshot-failure fixture now uses the real snapshot size limit rather than Unix permission semantics.
- `main` is the integration/release source, ordinary PRs into it are allowed, and direct pushes are permitted. The dependency lock contains patched Electron, fast-uri, and undici versions. CI audits both dependency trees.

Evidence: [task-contract.ts](../src/shared/task-contract.ts), [task-intake.ts](../electron/main/services/task-intake.ts), [tool-gateway.ts](../electron/main/services/agent/tool-gateway.ts), [task-scheduler.ts](../electron/main/services/agent/task-scheduler.ts), [live-review regressions](../tests/eris-dev-live-review.test.ts), [snapshot regression](../tests/eris-dev-followup.test.ts), and [GitHub workflow](GITHUB-WORKFLOW.md).

## Implementation and remaining acceptance

### REC-01 · P0 · Remove shared feedback credentials from distributable apps

**Status:** Implemented in source and packaging. Feedback is relay-only; CI no longer injects a shared token. Both builders exclude the legacy file and run a streaming after-pack credential scan. Synthetic filename/token-boundary tests pass. Whether older releases distributed a real token remains unverified; revocation and historical asset inspection remain operational follow-up.

**Change:** Keep issue-creation credentials on the feedback relay. Remove shared-token injection and the packaged-token fallback; retain an understandable relay-unavailable state. If a shared token has ever been distributed, revoke/rotate it and inspect the affected assets. Do not print token values while investigating.

**Acceptance:** A release with the CI secret configured cannot place it in either platform's app/resources/archive. The desktop submits through the relay without a shared GitHub credential; relay failure produces retry/support behavior. A packaging scan rejects secret filenames and known test-secret bytes.

**Where:** [release.yml](../.github/workflows/release.yml), [package.json](../package.json), [bug-report.ts](../electron/main/services/bug-report.ts), [FEEDBACK.md](FEEDBACK.md). Add regression coverage for packaged-resource exclusion and relay errors.

### REC-02 · P1 · Give cloud commands an enforceable job boundary

**Status:** Implemented a fail-closed Linux command boundary: bubblewrap namespaces, no network, only the selected workspace, empty environment plus explicit safe values, bounded tmpfs/output/time/file sizes, prlimit, and a required delegated cgroup v2 subtree for aggregate CPU/memory/process limits. A trusted launcher joins the cgroup before untrusted execution; cancellation kills the whole cgroup. Commands are disabled when the boundary cannot be established. Deployment-level escape/resource probes on the actual Linux host remain required.

**Change:** Run job commands in a separate restricted process/container boundary with only the job workspace and an explicit environment allowlist. Apply CPU, memory, process, time, and network limits. Keep service/admin/provider credentials outside the command environment. Describe denylist checks as supplementary policy.

**Acceptance:** A job cannot read another job's files, host/service credentials, or unrelated mounts. Cancellation terminates descendants. Resource-limit failures are attributed to the job. Tests use synthetic credentials and isolated fixtures; production secrets never become test inputs.

**Where:** [cloud workspace execution](../cloud-agent/src/workspace.ts), [command policy](../cloud-agent/src/sandbox.ts), [worker.ts](../cloud-agent/src/worker.ts), [Dockerfile](../cloud-agent/Dockerfile), and deployment configuration. Complete before expanding untrusted multi-tenant execution.

### REC-03 · P1 · Confine cloud file operations through real paths

**Status:** Implemented. Reads/writes reject absolute paths, traversal, drive paths and symlink components, including dangling links. File reads are bounded before allocation; tree/artifact traversal skips links and has depth/entry bounds. Synthetic cross-root and oversized-read regressions pass. Input overlay paths are validated before directory creation.

**Change:** Use realpath-aware confinement for reads, writes, missing parents, and clone-provided symlinks. Reject links that escape the job root. Bound file reads before allocation, with a clear truncation marker and byte limit.

**Acceptance:** Files, parent symlinks, dangling links, and platform path variants cannot escape a fixture root. A large file consumes bounded memory and returns bounded content. A rejected write leaves no external file or partial directory behind.

**Where:** [workspace.ts](../cloud-agent/src/workspace.ts); use the design of [desktop workspace-fs.ts](../electron/main/services/workspace-fs.ts) and [sandbox-paths.ts](../electron/main/services/sandbox-paths.ts) without assuming their desktop imports belong in the cloud package. This complements REC-02; neither replaces the other.

### REC-04 · P1 · Validate chat submissions at the IPC boundary

**Status:** Implemented. Strict versioned Zod submission schema, aggregate/field bounds, main-window/frame validation, thread ownership, workspace recheck and attachment confinement run before admission. Legacy plans are accepted as ignored data, not authority. Malformed input does not stop another task. Schema and actual chat IPC regressions pass.

**Change:** Add a versioned submission schema with field and byte/count bounds. Validate the sender and intended thread/workspace association, attachments, request IDs, modes, history roles, model/agent preferences, and finite timing values before admission. Return a structured rejection that does not abort another valid task.

**Acceptance:** Malformed, oversized, unknown-field, stale-workspace, and foreign-thread submissions fail predictably. Valid legacy payloads have an explicit migration path. Invalid input makes no provider call and performs no task mutation.

**Where:** [chat-stream.ts](../electron/main/ipc/chat-stream.ts), [api.ts](../src/shared/api.ts), [preload](../electron/preload/index.ts), and chat IPC tests. Follow the existing Zod validation pattern in [debug-runs IPC](../electron/main/ipc/debug-runs.ts).

### REC-05 · P1 · Make task admission, cancellation and replay durable

**Status:** Implemented with bounded snapshot recovery. FIFO foreground tasks own their controllers and cancellation owners; canonical digests enforce idempotency/conflict detection. Admission writes/syncs records before acknowledgement, reports a cursor, and rejects storage faults before inference. Events/snapshots support reattachment; active and terminal recovery is thread-specific. Terminal retention is 200 in memory and 500/30 days on disk, with thread-index cleanup. Regression tests cover concurrent duplicate admission, conflicting content, storage failure/retry and crash recovery. This remains bounded snapshot replay, not an unlimited event journal.

**Change:** Introduce a task-owned controller/queue and canonical submission digest. Acknowledgement should identify a durably admitted task and event cursor. Same ID plus same digest reattaches; same ID plus different digest conflicts. Surface degraded persistence and cap memory/disk retention. Decide explicitly whether foreground execution is queued or concurrent.

**Acceptance:** Two chat tabs cannot accidentally cancel or receive each other's output. Reload/duplicate submit executes effects once. Crash-before/after-admission tests distinguish unknown, stopped, and running work. Disk failures are visible; late task-A events cannot mutate task B. Eviction preserves active work and terminal results needed for reconnect.

**Where:** [chat-job-controller.ts](../electron/main/services/chat-job-controller.ts), [chat-stream.ts](../electron/main/ipc/chat-stream.ts), [app-state.ts](../electron/main/app-state.ts), [useChatSession.ts](../src/hooks/useChatSession.ts), and [task-ledger.ts](../electron/main/services/task-ledger.ts). Start after the submission contract in REC-04 is fixed.

### REC-06 · P1 · Replace background status text with typed execution/integration state

**Status:** Implemented typed waits, recorded integration branch/base, write-lock plus clean-branch/baseline checks, and shared-parent versus integrated receipts displayed in the inbox. Parent completion waits for children and fails if required child results are incomplete. Rewording display text no longer determines scheduling/blackboard blocking. Temporary Git-repository regressions verify branch/baseline/dirty-tree refusal and a successful integration receipt. Branch/baseline changes require review/rebase instead of merging into a different checkout.

**Change:** Persist typed waiting/blocking reasons, parent-child requirements, destination branch/base SHA, artifact state, and integration receipts. Render status text from those fields. Before applying/merging, verify the intended branch and baseline and report conflicts without disturbing unrelated work.

**Acceptance:** Rewording status text cannot alter scheduling. A blocked parent releases capacity reliably. A failed required child cannot produce a complete parent. Switching branches or changing the destination baseline prevents an unintended merge. Completion, patch-ready, integrated, and verified are separate user-visible states.

**Where:** [background-agents.ts](../electron/main/services/background-agents.ts), [agent-orchestration.ts](../src/shared/agent-orchestration.ts), [worktrees.ts](../electron/main/services/worktrees.ts), and the Agents inbox. Preserve existing authority intersection and overlap locks.

### REC-07 · P1 · Complete cloud task-contract v2 support before advertising it

**Status:** Partially implemented and safely disabled for desktop v2 routing. Cloud admission validates/persists v2 task scope/authority/obligations, checks each tool, confines subprojects, mounts verification workspaces read-only, hides Git metadata, checks publishing authority and preserves contracts on resume. Artifact-application errors fail the turn. Desktop fallback has an explanation. Health deliberately advertises version 1 until Linux sandbox, command-produced artifact baselines, obligation outcome accounting and full desktop/cloud conformance are validated. Do not change this to 2 merely to enable routing.

**Change:** Implement and test task-contract scope, effect ceilings, obligations, cancellation and artifact-baseline checks on the cloud server. Then advertise the supported contract version and capability set. Explain an incompatible server's local fallback to the user.

**Acceptance:** A conforming cloud server preserves the same no-edit/no-run/project constraints as desktop execution. An old server still fails closed/falls back with a reason. Contract support is validated behavior, not just a health-response number.

**Where:** [cloud-agent-inline.ts](../electron/main/services/cloud-agent-inline.ts), [cloud server](../cloud-agent/src/server.ts), [cloud worker](../cloud-agent/src/worker.ts), shared cloud API types, and artifact application. Depends on REC-02/03 for trustworthy command/file boundaries.

### REC-08 · P1 · Pin and publish release artifact provenance

**Status:** Implemented. All release matrix jobs use the resolved tag commit SHA. Committed manifest/lock versions must match the tag, and platform manifests record source/tag/lock hashes, signing state, workflow identity and asset checksums. Replacement requires explicit repair_existing; normal uploads do not clobber assets. Resolver regressions pass. The next CI release must contain these scripts and exercise both platform manifests; existing historical tags are not silently rebuilt from current main.

**Change:** Resolve the build source once to an immutable SHA and pass it to every matrix job. Record tag SHA, source SHA, lockfile digest, workflow/run identity, signing state, and asset checksums in a release manifest. Use a new version when application source changes; require an explicit repair policy for replacing an existing asset.

**Acceptance:** A later push during the matrix build cannot change either platform's source. Both platform artifacts have the same declared source and dependency digests. A manual build that differs from the tag is visible before publication. Existing tags are never silently moved.

**Where:** [release.yml](../.github/workflows/release.yml), [release.mjs](../scripts/release.mjs), [UPDATES.md](UPDATES.md), and [GITHUB-WORKFLOW.md](GITHUB-WORKFLOW.md). Keep the successful `main` branch model; do not restore the deleted `dev` promotion rules.

### REC-09 · P1 · Gate the real desktop interaction path in CI

**Status:** Implemented CI client, real process recovery and packaged renderer/preload smoke gates on macOS and Windows. Local client fixtures, scripted chat IPC/approvals, document/diff/worker tests and the macOS packaged smoke passed. Packaged smoke uses an isolated temporary profile, rejects invalid chat input and skips updater/model warmup. A single packaged end-to-end test covering valid scripted chat, all approval/diff/reload actions and signed update installation is still needed; separate integration and renderer tests do not establish that entire path.

**Change:** Add a bounded client smoke profile in CI and a packaged smoke job on supported platforms. Exercise real chat IPC with a scripted provider, visible tool events, approval deny/allow, diff accept/reject, unsaved editor buffers, renderer reload, stop, and restart recovery.

**Acceptance:** A user edit survives a stale agent patch. Reject restores the intended version without discarding later user work. Approval responses correlate to their task. Reconnect produces one terminal answer. The profile makes zero live-provider calls. Installer validation is reported separately from build success.

**Where:** [check:client scripts](../package.json), [checks](../checks/README.md), [chat-stream diagnostics tests](../tests/chat-stream-diagnostics.test.ts), editor state and chat UI, [ci.yml](../.github/workflows/ci.yml). Build on REC-04/05 rather than masking their race conditions with sleeps.

### REC-10 · P1 · Establish a representative live quality baseline

**Status:** Harness implemented; representative live baseline remains open. A versioned seven-stratum case pack includes no-project/project, follow-up, security and recovery cases. The opt-in adapter runner supports model/repeat matrices, per-call deadlines, call/output reservations, effective-settings capture, independent exact-JSON oracles and result-bound human adjudication. Five harness tests pass. Unadjudicated answers remain unresolved; no keyword/syntax check assigns semantic correctness. No new live calls or model-comparison claims were made.

**Change:** Maintain a stratified, versioned set of answer, code-example, patch, review, execution, follow-up, and security-sensitive tasks with independent obligations and artifact oracles. Add repeatable multi-model/settings runs and human adjudication for subjective cases. Keep live calls opt-in and budgeted.

**Acceptance:** Reports distinguish routing, applicability, execution, output completeness, correctness, unresolved judgments, export coverage, latency, and cost. Syntax/topic-word checks cannot establish semantic correctness. Include review-to-implementation conversations, no-project/project variants, refusals, timeouts and interrupted outputs. Compare identical fixtures and effective runtime settings.

**Where:** [Eris-Dev capture](../electron/dev/capture.ts), [eris-dev types](../src/shared/eris-dev.ts), [deliverable checks](../src/shared/deliverable-checks.ts), [debug-runs](../electron/main/services/debug-runs/evaluation.ts), topic rubrics, and eval fixtures. Preserve historical captures unchanged.

### REC-11 · P2 · Give credentials an explicit storage policy

**Status:** Implemented an explicit local/vault credential store with atomic synced migration, preserved unreadable legacy data, opt-in OS encryption, restrictive file permissions and explicit Windows current-user ACLs. Settings explain the vault prompt and migration/cleanup state. Renderer APIs expose presence only; filesystem IPC blocks credential files. Eris-Dev reads the same store and snapshots omit credentials/legacy ciphertext. Synthetic migration, deletion, unavailable-vault and unreadable-store tests pass. Real Windows ACL/vault and macOS unlock-prompt acceptance remain platform checks.

**Change:** Introduce a credential-store interface with an explicit user-controlled vault option and a clearly documented local fallback. Verify Windows ACL behavior. Migrate without silent credential loss or unexpected Keychain prompts. Keep secrets out of task snapshots and exports.

**Acceptance:** Existing users retain access or receive an actionable migration prompt. Secrets cannot be read through renderer APIs or diagnostic exports. Tests use synthetic values and exercise vault-unavailable, permission, migration and deletion paths.

**Where:** [ipc/shared.ts](../electron/main/ipc/shared.ts), [Eris-Dev model credential loading](../electron/dev/models.ts), account/provider settings and redaction tests. Resolve REC-01 independently; encrypting local user credentials does not make a shared bundled credential safe.

### REC-12 · P2 · Calibrate model capabilities and context budgets

**Status:** Implemented centralized configured capabilities for transport/compaction context, output cap, tool protocol and schema/counting provenance. API output caps are sent explicitly; termination metadata distinguishes configured ceilings from worker measurements, and usage aggregates split measured/estimated tokens. Existing protocol/history/cancellation regressions pass. Provider-specific measured tokenizer calibration and a complete adapter conformance matrix remain open; configured ceilings are not claimed as measured allocations.

**Change:** Centralize capabilities per resolved model/connection: effective context, output cap, tool protocol, supported schema features and tokenizer/estimation source. Record actual usage when available and label estimates. Add adapter conformance cases for partial tool calls, stop reasons, invalid JSON, cancellation, and small-context turns.

**Acceptance:** Mandatory task authority and paired tool observations survive every supported context size or fail explicitly before generation. Native/API outputs cannot silently lose call IDs. Requested values, measured usage, and estimates appear as distinct fields.

**Where:** [chat-runtime.ts](../electron/main/services/chat-runtime.ts), [model-protocol.ts](../electron/main/services/model-protocol.ts), [model-transport.ts](../electron/main/services/model-transport.ts), context compiler and native worker. Preserve the existing one-shot/session parity regressions.

### REC-13 · P2 · Validate native failure and installer recovery on real platforms

**Status:** Process/platform validation tooling implemented. The actual Electron utility-process probe passed loading/generation exits, five cancellations and successful fresh-worker recovery on macOS arm64/Electron 44.9.3. Packaged macOS renderer/preload smoke passed; both CI platforms run these gates. Probe reports explicitly exclude GPU/model-load/memory-pressure and signed installation/update certification. Those real-hardware/certificate checks remain open.

**Change:** Add opt-in hardware/process fault probes and platform installation/update smoke checks. Exercise worker exit during load/generation, repeated cancellation, model swap, memory pressure, and reopening the app. Report signing/notarization state explicitly and validate signed update paths when certificates are available.

**Acceptance:** The renderer remains responsive, pending callers terminate, stale sessions/resources are released, and a subsequent task can run. Signed updates verify and install; unsigned macOS builds clearly take the existing manual-install route. Findings include OS, architecture, model, backend, and effective limits.

**Where:** [llama-worker-channel.ts](../electron/main/services/llama-worker-channel.ts), [builtin-model.ts](../electron/main/services/builtin-model.ts), [inference-governor.ts](../electron/main/services/inference-governor.ts), [auto-update.ts](../electron/main/services/auto-update.ts), release workflow and [SIGNING.md](SIGNING.md).

### REC-14 · P2 · Extract runtime responsibilities after lifecycle tests exist

**Status:** Incremental extraction implemented: chat submission validation/digests, foreground scheduling, event persistence/publication/replay, credential storage and model capabilities have dedicated modules. Existing agent-loop behavior remains covered; admission, cancellation, persistence and process boundaries have regression checks. Further context/tool/finalization and renderer-subscription extraction remains a follow-up after the full packaged interaction profile, rather than a wholesale agent-loop rewrite.

**Change:** Extract task admission/event publication, context management, tool execution, recovery/finalization, and renderer subscription into explicit interfaces in small changes. Avoid replacing the agent loop as a single rewrite.

**Acceptance:** Existing behavior/authority tests remain intact. Each extracted state transition has one owner and typed input/output. Error, cancellation, cleanup, and persistence are tested at the boundary; file length reduction alone is not a completion criterion.

**Where:** [agent loop](../electron/main/services/agent/loop.ts), [chat IPC](../electron/main/ipc/chat-stream.ts), [chat-turn.ts](../electron/main/services/chat-turn.ts), and [useChatSession.ts](../src/hooks/useChatSession.ts). Sequence after REC-04/05/06/09.

## Delivery order

1. Address REC-01 before another release that could package the configured credential. Confirm deployment facts without reading or printing secret values.
2. Complete REC-02/03 before treating cloud user code as isolated. Add REC-07 capability support only after enforcement exists.
3. Land REC-04, then REC-05 and REC-06 in focused changes. Extend REC-09 alongside each new lifecycle contract.
4. Fix REC-08 before relying on manual release rebuilds as reproducible artifacts. Keep dependency audits and existing version/tag protections enabled.
5. Establish REC-10 as the quality baseline; pursue REC-11/12/13 with explicit compatibility and user-experience acceptance. Extract modules under REC-14 after those contracts are testable.

For each implementation, record the source commit, changed boundary, acceptance evidence, limitations, and newly discovered failure cases. Update this backlog when acceptance is met; do not infer completion from a green test count or an old report's status.

## Review provenance and cleanup

The old `ARCH-*`, `AG-*`, `FR-*`, and `MR-*` identifiers remain useful historical evidence. This review rechecked source paths and existing regressions rather than copying their open/closed labels. Legacy scenario/question IDs are retained in code and data; they are not new REC identifiers.

Historical machine-readable material remains available:

- [10,000-question improvement records](reviews/eris-dev-10000-2026-10-23/improvements.json) and [metrics](reviews/eris-dev-10000-2026-10-23/metrics.json).
- [Follow-up backlog](reviews/eris-dev-followup-2026-10-23/backlog.json) and its [probe results](reviews/eris-dev-followup-2026-10-23/probe-results.json).
- [Prior technical backlog](reviews/eris-dev-latest-2026-10-23/backlog.json).
- [132-case live review backlog](reviews/eris-dev-multi-2026-10-24/backlog.json) and [metrics](reviews/eris-dev-multi-2026-10-24/metrics.json).
- [Native replay summary](reviews/eris-dev-live-fix-2026-10-24/replay-summary.json).

Dated review Markdown, the old agent-v2 narrative, the product-improvement backlog, and the superseded smoke/debug design proposal were removed. JSON/JSONL/CSV, analyzer scripts, ZIP evidence, operational guides, and regression tests were retained. The diagnostics guide now links to this backlog rather than presenting obsolete routing findings as current behavior.

Implementation validation: desktop/cloud typechecks; **841 tests in 82 suites**, **5 quality-harness tests**, lint with zero errors (9 existing warnings); quality harness invariants; desktop build; client worker/renderer fixtures; packaged macOS smoke; actual Electron utility-process exit/cancellation/recovery probe. Test counts and remaining platform limitations are reported with this change. Live quality, production deployment and certificate-based installation acceptance remain open.

### REC-28 / issue #73 — multi-turn quality evidence implemented

Added nine versioned scenario families spanning real review/selection/implementation/explanation continuity, persistent review-only constraints, missing/unrelated/related synthetic projects, design, security and controlled recovery cases. Held-out prompts, seeded stratified ordering, explicit repeat/model budgets, per-recommendation artifact observations and digest-bound human review replace request-count or keyword-based quality claims. The development Electron adapter carries actual prior output, TaskContract results and one persistent fixture per session through production intake/model transport.

Validation: matrix/oracle invariants exercise true history/state continuity, independent subset failures, forbidden-effects observations, digest binding, live opt-in, conservative internal-call reservations, unknown fault costs, deadline cleanup, held-out variants and seeded order. Production-adapter regressions use mocked providers and isolated files to verify task continuity, new artifacts, cleanup, bounded-capability refusal and injected cancellation/provider attribution. The built headless entry is qualified without paid inference. REC-27 / #72 must merge before actual bounded model comparisons; older builds report not exercised with zero provider calls. Cold-load eviction remains explicitly unsupported. Live multi-model correctness, packaged application UI, broad behavioral execution and independent human adjudications remain qualification work, not claimed model success.
