---
slug: /guides
sidebar_label: Guide index
---

# Architecture and design guide index

Routing and request-execution guides updated on 2026-11-06 against local `codex/simplify-request-execution`, based on `7975140d` (v0.6.16), including uncommitted source changes. Older subsystem guides retain their own reviewed baselines. This index does not certify an installed or released build.

Use the guide matching the boundary being changed. Read its source baseline before turning an example or historical finding into an implementation task. Package version alone does not establish whether local unreleased changes are present.

## Current implementation

- [System architecture](ARCHITECTURE.md): process ownership, chat → task/agent, agent → agent/model, tools, memory, diagnostics and release boundaries.
- [Request resolution and execution](design/REQUEST-EXECUTION.md): authoritative guide for the simplified routing path, requested versus effective work, reference resolution, model-load guards, child assignments, file-set completion and evaluator deadlines. Start here for chat-routing changes.
- [Detailed handoff and RAM context](design/AGENT-HANDOFF-AND-RAM-CONTEXT.md): contracts, lifecycle, trust hierarchy, inherited requirements, bounded constraints, scopes and result integration.
- [Automatic model execution](design/AUTO-MODEL-EXECUTION.md): Fixed/Auto-local/Auto-any, task eligibility/ranking, real coordinator/worker execution and safe bounded switching.
- [Conversation memory](CONTEXT-MEMORY.md): implemented retention/recall, scaled allocation, journals/pull, revocation and pressure fallback.
- [Eris-Dev](ERIS-DEV.md), [live-model runs](ERIS-DEV-LIVE-MODELS.md), [diagnostics](DIAGNOSTICS-RUNS.md): separate request capture, actual inference, stateful replay and independent answer evaluation.
- [Image generation](image-generation.md): explicit model download, dedicated service/runtime, media ownership and shared-resource/Metal safeguards.

## Remaining target design

- [Router architecture review](reviews/2026-11-06-router-architecture-review.md): the original 12 findings and 20 proposed implementation packages. This is a pre-change review; use the implementation-status mapping in [request execution](design/REQUEST-EXECUTION.md#implementation-status-against-the-review) before treating a finding as an open defect.

- [Reference-informed agent enhancement architecture](design/REFERENCE-AGENT-ENHANCEMENT-ARCHITECTURE.md): 40 proposed packages with pinned external source, current-code boundaries, runtime contracts, durable handoff, resource budgets, migration and acceptance; [machine-readable index](design/REFERENCE-AGENT-ENHANCEMENTS.json).
- [RAM architecture and work packages](RAM-CONTEXT-ARCHITECTURE.md): reconciled implementation baseline/gaps plus remaining proposed worker/process, durability, quality and rollout contracts. MEM/GAP IDs are retained; do not assume every original task is still unimplemented.
- [Tiered VRAM/RAM amendment](RAM-CONTEXT-AMENDMENT-001.md): precedence rules, unified-memory constraints, target tier sizing and remaining durable/semantic/KV experiments.
- [Recommendations](RECOMMENDATIONS.md): current source-checked handoff/memory work plus the historical REC implementation/acceptance ledger.

## Operational and contribution contracts

- [GitHub workflow](GITHUB-WORKFLOW.md): task branches/PRs to main, rebuild versus release, immutable tag and repair rules.
- [Updates](UPDATES.md), [signing](SIGNING.md): updater assets/provenance and separately verified installation/signing acceptance.
- [Cloud service](../cloud-agent/README.md), [cloud installation](../cloud-agent/INSTALL.md), [fleet](CLOUD_AGENT_FLEET.md): separate version/task-contract capability and deployment isolation. Repository stubs are not evidence of production configuration.
- [Usage](ERIS_USAGE.md), [feedback](FEEDBACK.md): service contracts, credential boundaries, measured/estimated usage and validated issue links.
- [Client/runtime checks](../checks/README.md), [quality harness](../checks/quality/README.md): commands, fixture ownership, qualification and exclusions.

## Release readiness

- [v1.0.1 production release coding checklist](V1.0.1-RELEASE-CHECKLIST.md): 225 coding/acceptance obligations, 40 regression scenarios and 9 signoffs, reviewed against integrated main `b59c766` on 2026-11-01. Includes exact-source 1.x hardware/live-model certification, open-issue scope decisions, packaged/installed acceptance and evidence requirements. This is a release plan, not completed qualification.

- [v1.0.1 release issue reconciliation](reviews/v1.0.1-release-issues-2026-11-02.md): current-main review, 40 focused issues plus tracker #311, and a complete 274-ID evidence/issue ledger; credits the latest merged memory and replay work.

## Evidence and maintenance rules

`docs/fixes/`, `docs/changes/` and dated `docs/reviews/` reports preserve individual implementation/reproduction evidence. Their original commands, snapshots and numbers are historical. New integration notes can explain status; do not rewrite recorded outcomes as if rerun against latest main. [The handoff issue index](reviews/handoff-ram-issues-2026-11-01.md) records the current integrated/open distinction beside its pinned audit provenance.

A source feature, a scripted test, a packaged launch, a hardware measurement, a live-model result and an independently graded artifact prove different things. Record exact source/model/runtime, processed/total coverage, command, limitations and measured-versus-estimated values. Never infer 10,000 live answers from a routing corpus count or complete RAM inheritance from a prose handoff.

When code changes, update its implementation guide first, reconcile the target/work-package status, link executable specifications and adjust recommendations. Keep the release tag immutable; source documentation can move ahead of installed binaries.
