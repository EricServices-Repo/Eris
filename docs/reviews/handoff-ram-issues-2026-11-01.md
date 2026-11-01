# Handoff and RAM context: issue implementation index

Reviewed latest integrated main at `e7e90ba290a60469f87b3e32dd2dd4c55597bc88` on 2026-11-01. The [design input](../design/AGENT-HANDOFF-AND-RAM-CONTEXT.md) describes source snapshot `d7a10fd`; the issue bodies explicitly account for the newer connection-aware recall, Ollama and run-journal implementations.

Created 13 issues: eight bug tickets and five enhancements. Each contains pinned code links, evidence classification, reproduction or implementation fixtures, required changes, acceptance criteria and overlap/dependency boundaries.

This is a historical audit index, not a live issue-status report. Later implementation work, including [PR #281](https://github.com/EricServices-Repo/Eris/pull/281), addresses some dispatch/allocation boundaries; review the current ticket and code before starting a fix.

## Issues

- [#255: [P1] [HANDOFF-RAM 001] Isolate recall evidence leases so request A cannot rewrite unrelated request B](https://github.com/EricServices-Repo/Eris/issues/255) — bug.
- [#256: [P1] [HANDOFF-RAM 002] Revalidate RAM-derived background handoffs after the parent evidence lease ends](https://github.com/EricServices-Repo/Eris/issues/256) — bug.
- [#257: [P1] [HANDOFF-RAM 003] Preserve parent language and artifact constraints when building a child task](https://github.com/EricServices-Repo/Eris/issues/257) — bug.
- [#258: [P1] [HANDOFF-RAM 004] Protect required handoff constraints from optional-context truncation](https://github.com/EricServices-Repo/Eris/issues/258) — bug.
- [#259: [P1] [HANDOFF-RAM 005] Recheck recall after asynchronous model preparation immediately before provider serialization](https://github.com/EricServices-Repo/Eris/issues/259) — bug.
- [#260: [P1] [HANDOFF-RAM 006] Budget the first native-model request after measured context allocation, not before load](https://github.com/EricServices-Repo/Eris/issues/260) — bug.
- [#261: [P1] [HANDOFF-RAM 007] Cancel and join dependent child jobs before discarding a parent worktree](https://github.com/EricServices-Repo/Eris/issues/261) — bug.
- [#262: [P1] [HANDOFF-RAM 008] Bound background delegation depth, cycles and total task-tree model work](https://github.com/EricServices-Repo/Eris/issues/262) — enhancement.
- [#263: [P2] [HANDOFF-RAM 009] Keep conversation source identity separate from a child execution worktree](https://github.com/EricServices-Repo/Eris/issues/263) — enhancement.
- [#264: [P2] [HANDOFF-RAM 010] Persist source-backed child outcome receipts instead of importing results as plain assistant prose](https://github.com/EricServices-Repo/Eris/issues/264) — enhancement.
- [#265: [P2] [HANDOFF-RAM 011] Validate and bound handoff envelopes before inline execution or background persistence](https://github.com/EricServices-Repo/Eris/issues/265) — enhancement.
- [#266: [P1] [HANDOFF-RAM 012] Admit run-journal scratch memory before allocating or materializing tool-output buffers](https://github.com/EricServices-Repo/Eris/issues/266) — bug.
- [#267: [P2] [HANDOFF-RAM 013] Add isolated multi-agent RAM handoff replay to Eris-Dev and CI](https://github.com/EricServices-Repo/Eris/issues/267) — enhancement.

## Reproduction evidence

Reproductions were executed in an isolated archive of the pinned main source, with fake provider adapters and disposable data. They did not alter the working project, submit real feedback, transmit model data, delete user worktrees or intentionally exhaust host memory.

- Cross-request privacy lease: unrelated request B was replaced with request A intent.
- Expired parent lease: synthetic persisted derived handoff text remained unchanged by filtering.
- Child interpretation: parent language Python became null in the child.
- Optional briefing packing: the required currency marker was omitted under a crowded compiler budget.
- Late source revocation: the fake provider payload still contained PRIVATE-A after revocation during model preparation.

The five new audit expectations failed against the pinned implementation; the existing 19 dispatch regression cases passed. These are defect reproductions, not a claim that the application passed new acceptance tests. Source-confirmed issues without executed fixtures are explicitly labeled in their bodies.

## Existing work reused

The broad specialist-handle proposal remains #151; this review creates distinct implementation slices and concrete defects rather than recreating that umbrella. Existing #226, #229, #230 and #225 remain the owners of general context allocation, tokenizer accuracy, placement and durable journals. Closed #125/#126, #146, #149, #219/#220, #221 and #237 are referenced where later code exposes a remaining boundary or regression.

## Suggested implementation order

1. #255 request isolation, #259 final revalidation, #256 durable child privacy lifecycle.
2. #261 cancellation/worktree cleanup and #262 task-tree budgets.
3. #265 schema and #263 source/execution identity mapping.
4. #257 semantic inheritance, #258 required handoff packing and #264 return receipts.
5. #260 measured native first-request budgeting and #266 journal transient admission.
6. #267 full task-tree replay, adding each fixed boundary as a permanent scenario.

Do not infer live-model or hardware certification from these deterministic cases.
