# Eris agent request capture: technical improvement specification

Review date: 2026-10-23. Source: `eris-dev-requests-1.jsonl`. This document is intended as an implementation handoff to engineers and coding models. It specifies changes; it does not claim they have been implemented.

## Executive assessment

The latest application successfully constructs 10,000 model requests, but request reachability is ahead of semantic correctness. The most consequential remaining problem is the coupling of intent, worker role, workspace grounding and output shape. An overly broad edit heuristic becomes a read-only plan after a zero-confidence resolver reply; the planner then adds project-inspection obligations even when intake identifies the task as generic. Separately, narrow code-example patterns discard clear user requests for implementations. These errors can steer a capable model toward a poor answer before inference begins.

There are 837 confirmed generic-scope/file-grounding contradictions. Two explicit code/example patterns account for 278 artifact omissions (243 practical-example questions and 35 write-behavior questions). Another 320 code examples are routed to exploration. These groups can overlap with other findings and must not be summed into a unique failure total. The 40 requests for both simple and robust versions retain only one implementation obligation. User text remains available to the model, so missing obligations do not prove that a future answer would omit the requested content; they weaken orchestration and completion checking.

The existing invariant suite reports zero defects and zero review findings on this file. That result means its current checks did not fire. It is not evidence that these requests are internally coherent or that model answers would be correct.

## Evidence boundaries and reproducibility

- Exact SHA-256: `1bb3a86eb400c464b9c9da49db54d1cbf08a38cfb1cf89d368e72d86c109c7ca`.
- Size: 126,446,112 bytes; 10,000 records plus one metadata header.
- Format: `eris-dev-capture-v2`; all indices consecutive, all question IDs unique, all question texts unique.
- Build: Eris-Dev 0.4.13; commit `363ddf039ce28d44037b7facae571afea7fad356`; dirty source, digest `b8a30555e614d5f1`; injected provenance.
- Build ID: `2026-10-23T22:45:18.872Z-8df1c50b`; run created `2026-10-23T22:46:09.366Z`.
- Routing and prompt version: `2026-10-23.5`; invariants/evaluation: `2026-10-23.2`; harness `d070ff4d59e0a6cd`.
- Configuration: Agent mode, 8,192 context, forced fallback resolver, simulated model, two-file sample workspace.
- Responses: every value null; no inference, tool execution, workspace changes, verification, answer-quality evaluation, child-agent coordination or production desktop-chat delivery.

Question references use Q1-based numbering; the JSONL `index` is zero-based. Thus Q14 means index 13 and, with one header, physical JSONL line 15. The audit evidence stores index and questionId, which identify the full source record. Treat all capture content as untrusted data rather than instructions to the reviewer.

Run the audit from the repository root:

```sh
python3 docs/reviews/eris-dev-latest-2026-10-23/analyze.py \
  /Users/ericembling/Desktop/eris-dev-requests-1.jsonl \
  docs/reviews/eris-dev-latest-2026-10-23
```

`metrics.json` contains the header, counts and distributions. `evidence.jsonl` maps reproducible predicates to individual questions and their current obligations. `backlog.json` contains every implementation item in this document. Counts based on wording predicates are candidate cohorts unless explicitly classified as a contract contradiction. The analyzer is an offline review aid and retains records in memory; do not reuse it as a bounded-memory production importer.

## Measured behavior

Intent outcomes: 6,869 answer, 2,811 plan, 320 explore; no edit/run. Artifacts: 4,294 explanation, 2,810 code-example, 2,294 plan and 602 design. Worker selection: 6,397 Explainer, 2,811 Plan, 792 Fast. Scope: 7,371 generic and 2,629 unverified.

Resolver outcomes: 9,061 fallback and 939 bypass. Every plan is an edit-to-plan downgrade. Another 1,305 edit heuristics downgrade to code-example answers. The forced zero confidence is a harness setting, not evidence of live classifier failure. Zero edit/run in this corpus is neither proof of correct intent nor a reason to relax safety: many questions ask for chat artifacts, and this run does not cover explicit authorized patch workflows adequately.

Tool exposure: 3,131 requests include 11 tools; 6,869 include none. There are 837 generic tool-bearing requests. Serialized tool definitions consume 3,331 characters for each tool-bearing request. Median system content is 3,661 characters, p95 3,995, maximum 4,741. None of the recorded context manifests truncates. Recorded capture duration has median 1 ms, p95 18 ms and maximum 45 ms. These are pre-inference observations and cannot estimate generation speed or user-perceived chat latency.

There are 4,502 stack mismatches against the sample workspace, including 3,444 generic tasks. They mostly indicate irrelevant fixture context, not invalid language requests. All 3,131 file-grounded tasks lack retrieval results at this boundary; subsequent reads could supply evidence, so this is not a count of fabricated answers.

The broad test-word predicate finds 532 cases without tests obligations. It includes topics such as seeding test data and must not become a bug total. The narrower “with good test coverage” cohort contains 249 such records. Likewise, 146 error-boundary questions have no inferred language or concept mismatch; this is diagnostic context, not proof of a defect—React phrasing can be valid without choosing JavaScript versus TypeScript.

## Target architecture

Implement one typed decision pipeline that separates six concerns: requested artifact, destination, applicability of workspace evidence, permitted effects, worker capabilities and completion obligations. Intent is a workflow hint, not the source of all six decisions. Extract the user’s requested artifact and source spans first. Resolve references and workspace relevance next. Apply permission ceilings independently. Select a worker and tool subset only after those decisions. Finally compile one coherent contract, workflow and response specification.

A suggested internal shape is:

```ts
type TaskDecision = {
  artifact: RequestedArtifact
  destination: 'chat' | 'workspace' | 'new-project'
  evidenceScope: { applicability: ScopeApplicability; projectId?: string }
  effects: TaskAuthority
  obligations: Array<{
    id: string
    kind: string
    sourceSpan?: { start: number; end: number }
    component?: string
    completionEvidence: 'response' | 'diff' | 'execution' | 'source'
  }>
  resolution: { source: string; rule: string; alternatives: string[] }
}
```

This is a proposed schema, not an existing API. Reuse existing TaskContract types where appropriate and version serialized changes. Do not build a second competing router in Eris-Dev: the debug application should execute production logic and use independent expectations to judge it.

Authority and relevance are different. Permission to read the project does not mean a generic question should read it. A read-only task can request executable code in chat. A model unable to confidently classify an edit does not mean the desired artifact is a plan. A directory existing on disk does not mean it is evidence for the question. These distinctions should be enforced in types and invariants before prompt rendering.

## Detailed implementation backlog

Priorities: P1 blocks meaningful agent-quality qualification or preserves a user-visible contract failure. P2 improves precision, efficiency or diagnosability. No crash, unauthorized write or model-generated incorrect answer is established by this capture. “Confirmed” refers to exported request structure or inspected source behavior.

### LR-001 — Compile generic tasks without mandatory workspace grounding

**Priority:** P1. **Evidence:** Confirmed contract contradiction.

837 records are marked generic but acceptance requires an answer or plan grounded in inspected files. Q1 (index 0) and Q28 (index 27) also explicitly prohibit citing the open project as evidence.

**Implementation ownership:** `electron/main/services/chat-router.ts`, `electron/main/services/agent/prompts.ts`, `electron/main/services/agent/context-compiler.ts`.

**Required change:** Make executionPlanFor, intentPlaybook and taskProtocol consume scope applicability and artifact, rather than intent alone. A generic design or code example needs conversation evidence and explicit assumptions, not a mandatory source inspection. Remove the contradictory acceptance criterion at construction time; adding another overriding sentence leaves the contradiction in place. Preserve source inspection for actual repository questions.

**Acceptance criteria:** At captureQuestion, Q1 and Q28 must contain no mandatory file-grounding criterion or instruction. A paired “Explain the implementation in src/auth.ts” must still require inspected-source evidence. Assert the compiled request as well as the internal task.

### LR-002 — Serialize applicability into the authoritative model contract

**Priority:** P1. **Evidence:** Confirmed information loss.

All 10,000 model-facing scope objects omit applicability although the internal task records generic or unverified. They present project “.” and state “resolved”.

**Implementation ownership:** `electron/main/services/agent/context-compiler.ts`, `src/shared/task-contract.ts`.

**Required change:** Extend modelFacingTask.scope with applicability and an evidence requirement enum. Keep filesystem resolution distinct from semantic relevance. For a generic task, emit a nullable evidence project or a clear non-evidence binding while retaining the internal root for safety. Do not drop named-target constraints. Version the model-facing contract and compare it independently of prose.

**Acceptance criteria:** Round-trip fixtures for generic, unverified, selected-project and named-target preserve applicability. A resolved directory must never by itself imply task relevance. Preserve project roots internally for any permitted tool call.

### LR-003 — Recognize practical-example requests without a production verb

**Priority:** P1. **Evidence:** Confirmed artifact omission.

243 requests starting “I need a practical example of” are explanations; Q14 asks for database connection pooling in Python and receives only Answer the question directly.

**Implementation ownership:** `src/shared/agent-contract.ts`, `src/shared/task-interpretation.ts`.

**Required change:** asksForCodeExample currently requires both a producing verb and an artifact noun. Add a request-form parser that recognizes need/want/request plus an example noun phrase. Extract deliverable independently of mutation authority. An example in Python remains chat code unless an explicit workspace destination exists. Keep quoted examples as operands rather than imperative instructions.

**Acceptance criteria:** Every adjudicated practical-example case gets code-example and an implementation obligation. Contrasts “Explain why this example fails” and “Review this example” remain explanation/review. No new write authority is granted.

### LR-004 — Recognize writing behavior without an artifact keyword

**Priority:** P1. **Evidence:** Confirmed artifact omission.

35 “Can you write … so the happy path is obvious and errors are explicit?” cases become explanations. Q6 asks for per-user rate limiting.

**Implementation ownership:** `src/shared/agent-contract.ts`, `electron/main/services/task-resolver.ts`, `src/shared/task-interpretation.ts`.

**Required change:** The verb write can request code without containing example/function/module. Bind the verb to the behavior clause and quality constraints. Retain prose-writing negatives such as “write a summary”. Resolve destination separately: a generic implementation belongs in chat; an explicit file destination may authorize a patch under the existing permission ceiling. Audit modal-imperative bypass so it does not freeze an incomplete artifact interpretation.

**Acceptance criteria:** Q6 receives code-example, explicit-error handling and clarity obligations. “Write a summary of rate limiting” stays prose. “Write the limiter into src/limit.ts” retains patch behavior in Agent mode.

### LR-005 — Prevent lookup wording from turning examples into repository exploration

**Priority:** P1. **Evidence:** Confirmed route/contract mismatch.

320 code-example requests route explore; Q28 and Q43 show the phrase “Show me” and get read tools plus file-grounded acceptance.

**Implementation ownership:** `electron/main/services/chat-router.ts`, `src/shared/agent-contract.ts`, `electron/main/services/task-resolver.ts`.

**Required change:** Evaluate object and destination before the lookup-wording rule. “Show an example of X” is a generation request; “show where X is implemented” is repository exploration. Keep the artifact authoritative when a fallback retains the heuristic. Route a generic example to an answer-capable worker with a code contract and no mandatory local inspection.

**Acceptance criteria:** Boundary tests distinguish both forms and assert tool policy, artifact and final prompt. Label all 320 candidates before imposing an exact intent-count gate; generic example requests must not require unrelated project evidence.

### LR-006 — Replace edit-to-plan as the universal non-mutating fallback

**Priority:** P1. **Evidence:** Confirmed fallback behavior; semantic adjudication required.

All 2,811 plan outcomes come from edit-to-plan. This includes 277 “Explain how to implement …” questions, such as Q5 about rotating secrets.

**Implementation ownership:** `electron/main/services/task-resolver.ts`, `electron/main/services/chat-router.ts`, `src/shared/task-interpretation.ts`.

**Required change:** conservativeFallback should remove unauthorized effects while preserving the requested deliverable. Compute a provisional artifact before choosing a safe fallback: explanation→answer, code-example→answer, ordered steps→plan, design→answer or scope-aware planner. Explicit edit intent with unresolved authority should produce a recorded ambiguity, not pretend that the user asked for a plan. Avoid weakening effect guards.

**Acceptance criteria:** Q5 has an explanation contract; explicit “give me a migration plan” remains plan. An ambiguous edit request cannot acquire write/run authority after timeout or malformed intent JSON. Test malformed, timeout and low-confidence independently.

### LR-007 — Extract architecture intent from structural phrasing

**Priority:** P2. **Evidence:** Semantic review candidate.

295 “How should I structure the code for …” requests become explanations. Q13 asks about logout across devices using Express and TypeScript.

**Implementation ownership:** `src/shared/task-interpretation.ts`.

**Required change:** asksForDesign matches “how would you structure” but misses common equivalent forms. Represent architecture deliverables with interfaces, state ownership, dependencies and tradeoffs. Add paraphrases through a labeled fixture set rather than blindly matching every use of structure. Preserve a concise explanation when the user only asks about a syntax structure.

**Acceptance criteria:** Reviewed structural-design cases retain design obligations across would/should/can formulations. Include negative fixtures for a language data structure and an explanation of existing source. Report precision and recall on held-out wording.

### LR-008 — Preserve requested output multiplicity

**Priority:** P1. **Evidence:** Confirmed obligation under-specification.

40 questions request both a simple and a more robust version. Each has one generic implementation obligation; Q43 is error boundaries with retry. The original user text survives, but structured completeness checks cannot enforce both versions.

**Implementation ownership:** `src/shared/task-interpretation.ts`, `src/shared/task-contract.ts`.

**Required change:** Add artifact components with stable IDs, roles and cardinality: simple implementation, robust implementation, comparison/selection guidance where requested. Do not represent multiple deliverables as a single free-text sentence. Carry each component through handoffs and completion reporting. This generalizes to alternatives, migration stages and backend/frontend pairs.

**Acceptance criteria:** A response containing only one version leaves the second pending. A response with two headings but identical/incomplete bodies does not automatically satisfy both. Ordering changes preserve component identity.

### LR-009 — Retain testing requirements in plans and design replies

**Priority:** P1. **Evidence:** Confirmed obligation under-specification.

249 questions containing “with good test coverage” have no tests obligation. Q42 requests a transactional-email approach with good test coverage. The broader 532 test-word matches include test-data topics and are not a defect count.

**Implementation ownership:** `src/shared/task-interpretation.ts`.

**Required change:** requestObligations adds tests only for code-example and patch. Introduce testing-strategy obligations for plan/design/explanation when coverage is requested; actual test-code obligations remain appropriate to code generation. Separate discussing coverage, writing tests, and executing tests. Keep “test data” as a domain noun rather than an execution request.

**Acceptance criteria:** Q42 must address test boundaries, fixtures and failure modes without claiming execution. “Seed realistic test data” alone must not require writing or running a test suite. Explicit no-run constraints survive.

### LR-010 — Record behavior and quality constraints as evidence-linked obligations

**Priority:** P2. **Evidence:** Observed weak obligation representation.

Q6 requests explicit errors; Q43 requests robust and simple variants. Most obligations contain only an artifact template, leaving detailed requirements solely in raw user text.

**Implementation ownership:** `src/shared/task-interpretation.ts`, `src/shared/task-contract.ts`.

**Required change:** Introduce source spans and requirement kinds for behavior, failure handling, performance, compatibility and presentation. Preserve the exact user phrase beside normalized meaning and extraction confidence. Never invent requirements from a topic name. Bounded extraction should retain an unparsed-requirements marker instead of silently discarding excess clauses.

**Acceptance criteria:** A lossless trace maps each explicit constraint to an obligation or a deliberate non-requirement classification. Counterexamples cover quoted instructions, negated effects and merely descriptive requirements.

### LR-011 — Remove unrelated workspace mismatch guidance from generic answers

**Priority:** P2. **Evidence:** Confirmed irrelevant-context injection.

3,444 generic tasks have stackFit=mismatch against the sample JavaScript fixture. The fixture has only two files and is unrelated to most questions.

**Implementation ownership:** `electron/main/services/task-intake.ts`, `src/shared/task-interpretation.ts`, `electron/main/services/agent/prompts.ts`.

**Required change:** When applicability is generic, use the requested language/framework directly; retain project stack only in diagnostics if needed. Do not tell a Python example request that the unrelated open project uses JavaScript. For actual workspace patches, retain mismatch analysis and the requirement to resolve the target.

**Acceptance criteria:** The same generic Python request compiled with unrelated JavaScript and PHP fixtures has the same semantic contract and equivalent prompt after volatile fields are removed. Actual project migration requests continue to expose stack mismatch.

### LR-012 — Determine scope relevance independently of artifact category

**Priority:** P1. **Evidence:** Confirmed architectural coupling.

scopeApplicability treats only code-example/design/explanation as generic candidates. The export contains 2,629 unverified scopes; plan selection can therefore force a generic request into project-oriented handling.

**Implementation ownership:** `electron/main/services/task-intake.ts`.

**Required change:** Compute applicability from references, selected context, supplied attachments and destination before plan/answer worker selection. Model explicit, inferred and absent workspace binding. Distinguish a hypothetical “existing Next.js project” from a positively identified current project; preserve ambiguity rather than silently binding the sample fixture.

**Acceptance criteria:** Equivalent design and plan phrasing does not change scope without evidence. Paired tests cover generic architecture, selected-file questions, named sibling projects and a hypothetical project of a different stack.

### LR-013 — Make generic tool exposure capability-driven

**Priority:** P2. **Evidence:** Confirmed avoidable exposure; latency benefit unmeasured.

837 generic requests expose 11 workspace tools; 3,131 total requests carry that same tool set. Each tool-bearing request has 3,331 serialized schema characters in this capture.

**Implementation ownership:** `electron/main/services/tool-registry.ts`, `electron/main/services/agent/loop.ts`.

**Required change:** Derive required capabilities from scope and evidence needs. Generic code generation should not need tree, git_status or git_diff. Permit targeted public documentation retrieval when appropriate instead of treating all non-mutating tasks as workspace readers. Tool-policy permission is an upper bound; relevance selects the subset. Do not grant deferred tools beyond authority.

**Acceptance criteria:** A generic code example has no local-file tools unless the user references local evidence. A repository explanation retains needed reads. Measure real provider prefill and tool-call counts before claiming a speedup.

### LR-014 — Separate read permission from a findings response format

**Priority:** P1. **Evidence:** Confirmed prompt overreach.

taskProtocol emits “Return findings with file paths” whenever tools exist and edit is false, including generic code examples and designs.

**Implementation ownership:** `electron/main/services/agent/context-compiler.ts`, `electron/main/services/agent/prompts.ts`.

**Required change:** Make the effects paragraph describe permissions only. Render output requirements from artifactResponseContract. Review tasks may require findings; an example requires code; a plan requires steps. Keep observed-source citations conditional on actual evidence and project relevance. Avoid fixing this by appending a second format instruction.

**Acceptance criteria:** Compile all intent/artifact pairs in the supported matrix. Read-only code-example and design prompts must not require a review report. Review and verification formats continue to demand evidence for claims.

### LR-015 — Deduplicate semantic instructions across role, plan and context blocks

**Priority:** P2. **Evidence:** Observed prompt repetition.

Q1 repeats planner duties in role guidance, PLAN PLAYBOOK, AGENT CONTRACT and PLAN STEPS. The invariant detects duplicate shared-rule headers, not semantic repetition. Median system text is 3,661 characters.

**Implementation ownership:** `electron/main/services/agent/prompts.ts`, `electron/main/services/chat-prompt.ts`, `src/shared/agent-contract.ts`.

**Required change:** Build typed prompt blocks with identity, purpose and applicability; render role identity once, workflow once and acceptance once. Avoid exact-string subtraction as the primary deduplication mechanism. Role descriptions should not reintroduce obligations already omitted by task scope. Track block contribution to request size.

**Acceptance criteria:** Snapshot block IDs and generated clauses. Each task has one workflow and one response contract; instructions required by authority remain present at 4k and 8k contexts. Measure size reductions without setting an arbitrary quality-blind compression target.

### LR-016 — Route by deliverable complexity rather than message length

**Priority:** P2. **Evidence:** Observed suspect assignment.

792 cases use Fast. Q14, a Python connection-pooling example misclassified as explanation, uses Fast; its role contract describes one to three sentences. No correctly classified code-example case uses Fast in this export.

**Implementation ownership:** `src/shared/agent-contract.ts`, `electron/main/services/chat-router.ts`.

**Required change:** Fix artifact recognition first, then assign workers using deliverable complexity and evidence requirements. Short text can request concurrency, security or multi-file examples. A fast worker must honor the same artifact contract; response brevity may not suppress required code or tests. Keep low-cost handling for actual lookup questions.

**Acceptance criteria:** Short practical-example requests cannot receive a sentence-only completion contract. Short factual lookups still use Fast. Compare worker assignments and artifact completeness on held-out concise prompts.

### LR-017 — Extend invariants to independently detect scope and artifact loss

**Priority:** P1. **Evidence:** Confirmed detection gap.

Every record reports zero defect/review findings, including all 837 conflicting generic requests. Current checks focus on authority, a few artifact combinations and textual markers.

**Implementation ownership:** `electron/main/services/agent/request-invariants.ts`, `tests/agent-corpus-boundary.test.ts`.

**Required change:** Add generic-requires-project-evidence, explicit-example-without-implementation and output-cardinality-loss checks. Use independently authored fixtures or expected labels rather than the same helper that creates the contract. Keep deterministic contradictions as defects and semantic uncertainty as review candidates. Export evidence snippets and rule versions.

**Acceptance criteria:** Known failing captures trigger the new invariant IDs. Correct paired captures do not. A mutation test removing a required artifact obligation must fail qualification even if all existing routing helpers agree.

### LR-018 — Add independently labeled gold expectations

**Priority:** P1. **Evidence:** Coverage gap.

The corpus is 10,000 unique questions with zero actual answers. Distribution and no-findings assertions cannot establish whether the requested deliverable was preserved.

**Implementation ownership:** `tests/agent-corpus-boundary.test.ts`, `tests/qualification-profiles.json`, `src/shared/eris-dev.ts`.

**Required change:** Create a separate annotation file keyed by content ID with expected artifact set, destination, permission ceiling, evidence scope and mandatory obligations. Allow multiple acceptable intents when the final behavior is equivalent. Track adjudication, rationale and disagreement. Prioritize the confirmed cohorts, then stratify the rest; do not auto-label using production routing.

**Acceptance criteria:** Release reports distinguish labeled from unlabeled coverage and show per-class confusion matrices. No overall semantic accuracy is reported for unlabeled records. All high-risk authority cases have reviewed expectations.

### LR-019 — Split paraphrase families across development and held-out suites

**Priority:** P1. **Evidence:** Evaluation design gap.

The data is lexically unique but repeatedly uses templates such as “I need a practical example of” and “How should I structure the code for”. Unique text count is not independent scenario coverage.

**Implementation ownership:** `tests/fixtures/10000-natural-diverse-coding-questions.txt`, `tests/qualification-profiles.json`.

**Required change:** Assign template-family and topic IDs; split by both family and topic when building holdouts. Include naturally authored follow-ups, typos and mixed instructions. Reserve a hidden evaluation subset from route-rule development. Report cluster-weighted results so hundreds of near-identical examples do not dominate the score.

**Acceptance criteria:** New rule changes pass a holdout with unseen phrasing. Reports show topic, family and permission coverage. No production helper generates the expected holdout labels.

### LR-020 — Exercise resolver outcomes beyond forced zero confidence

**Priority:** P1. **Evidence:** Coverage gap.

9,061 records use fallback and 939 bypass. The header explicitly selects intentReplyMode=fallback; this is not a measured 90.61% live classifier failure rate.

**Implementation ownership:** `electron/dev/capture.ts`, `electron/dev/questions.ts`, `electron/main/services/task-resolver.ts`.

**Required change:** Add variants for valid high confidence, below-threshold, malformed JSON, timeout, abort, forbidden edit escalation and semantically wrong but confident replies. Keep expected effects independently specified. Record the scripted reply, accepted/rejected decision and reason. A validated live resolver sample can be a separate budgeted suite.

**Acceptance criteria:** Every resolution branch is exercised and counted. Confident unsafe replies cannot override explicit constraints. Reports never mix simulated confidence distributions with observed provider confidence.

### LR-021 — Add an opt-in bounded real-answer evaluation stage

**Priority:** P1. **Evidence:** Coverage gap.

All 10,000 response values are null; inference is not-run and answerQuality is not-evaluated. No statement about generated-answer correctness can be made.

**Implementation ownership:** `electron/dev/capture.ts`, `src/shared/debug-runs.ts`, `electron/main/services/model-transport.ts`.

**Required change:** Keep request capture as a cheap tier. Add a separately selected live tier using configured model references, bounded cases/tokens/time/concurrency and explicit cancellation. Persist actual messages, provider metadata, first-token latency, completion and errors. Sandbox execution separately from inference. Begin with a stratified labeled subset rather than sending all 10,000 blindly.

**Acceptance criteria:** A run manifest states model revision and budget, distinguishes skipped from failed, and resumes without recharging completed cases. Stopping prevents new dispatches and drains or aborts active requests. No simulated answer is labeled live.

### LR-022 — Use executable code-quality fixtures for representative topics

**Priority:** P1. **Evidence:** Coverage gap, previously acknowledged.

This capture has no responses. Existing implementation-status documentation also notes token-level grading cannot reject incorrect code that uses expected keywords.

**Implementation ownership:** `src/shared/code-grading.ts`, `src/shared/topic-rubrics.ts`, `src/shared/debug-runs.ts`.

**Required change:** For selected languages/topics, extract code into isolated fixtures and compile/run behavioral tests under resource and network limits. Use topic-specific failure cases: limiter boundaries, duplicate idempotency keys, pool exhaustion, cancellation and retries. Separate compilation, behavioral correctness, security expectations and presentation. Treat keyword evidence only as diagnostic.

**Acceptance criteria:** An intentionally incorrect implementation with all expected keywords fails. A correct idiomatic alternate passes. Environment/toolchain failure is evaluation-invalid, not a model failure; test execution cannot access production secrets or the user workspace.

### LR-023 — Test review-to-implementation conversations end to end

**Priority:** P1. **Evidence:** Coverage gap central to prior user failures.

The header excludes tool execution, workspace changes and agent coordination. These single-question captures cannot reproduce “recommend changes” followed by “add those changes”.

**Implementation ownership:** `electron/main/services/chat-turn.ts`, `electron/main/services/task-intake.ts`, `src/shared/recommendations.ts`, `src/shared/debug-runs.ts`.

**Required change:** Create multi-turn scenarios with a reviewer answer, selection of recommendations, explicit implementation follow-up and a verified workspace diff. Include subset selection, negation, cancellation, model switch and conflicting earlier role guidance. Assert that current authorization determines tools while prior assistant content supplies references only.

**Acceptance criteria:** “Add those improvements” creates the intended patch with all selected obligations accounted for. “Explain those improvements” remains read-only. Reviewer-to-coder handoff cannot retain “do not edit” after a valid edit contract is created, or inherit ungranted effects.

### LR-024 — Verify actual child-agent lifecycle and permission ceilings

**Priority:** P1. **Evidence:** Coverage gap.

The export explicitly does not exercise agent coordination; delegation tools are blocked by the captured read policy. Their absence here does not prove a delegation defect.

**Implementation ownership:** `electron/main/services/agent/loop.ts`, `src/shared/background-agents.ts`, `src/shared/agent-orchestration.ts`.

**Required change:** Add coordinator scenarios that create real child tasks in an isolated workspace, transmit immutable task revision and permission ceilings, await completion, handle failure/cancellation and reconcile evidence. Require structured result references and changed-file ownership. Test sequential and background paths separately, including an absent recovery agent.

**Acceptance criteria:** A queued child is never marked completed; cancelled children cannot continue edits; parent conclusions cite child evidence. A read-only parent cannot obtain writes by delegation. Recovery terminates with an explicit blocked reason rather than repeating tools indefinitely.

### LR-025 — Validate provider serialization and local tool grammar

**Priority:** P1. **Evidence:** Coverage gap.

All requests target simulated:scripted and show native function calling. No local GGUF chat template or remote provider wire format is exercised.

**Implementation ownership:** `electron/main/services/model-transport.ts`, `electron/main/services/tool-protocol.ts`, `electron/main/services/agent/tool-validation.ts`.

**Required change:** Replay canonical requests through each supported adapter using deterministic transport fixtures. Assert role ordering, system handling, tool schema conversion, IDs, tool results, stop sequences and text-tool fallback grammar. Follow with a small real local-model canary where available. Record provider/model capabilities in provenance.

**Acceptance criteria:** A complete read→tool-result→answer cycle survives each adapter. Unsupported native tools switch through an explicit capability decision. A malformed call becomes a bounded correction opportunity and cannot silently disappear from chat.

### LR-026 — Measure whole-request tokens using the selected model tokenizer

**Priority:** P2. **Evidence:** Design improvement; no truncation observed.

All 10,000 context manifests use character estimates; none records truncation. context-compiler uses three characters per token and a 55% system share.

**Implementation ownership:** `electron/main/services/agent/context-compiler.ts`, `electron/main/services/agent/context-budget.ts`, `electron/main/services/model-transport.ts`.

**Required change:** Add a tokenizer/capability adapter and account for system, history, tool schemas, provider framing and reserved output together. Retain a conservative documented fallback when exact tokenization is unavailable. Test small local context windows, code-dense and multilingual messages. Do not describe captured millisecond routing times as model performance.

**Acceptance criteria:** For known tokenizers, request estimates match serialized inputs within a defined tolerance. Mandatory instructions never truncate silently. Budget failure has an actionable UI error, and reports distinguish estimated from measured counts.

### LR-027 — Use fixtures that expose scope and retrieval failures

**Priority:** P1. **Evidence:** Coverage gap.

The only project is a two-file sample fixture. All records have no retrieval result evidence, including 3,131 tasks requiring file-grounded answers; reads could occur after capture, so this count is not a fabricated-answer count.

**Implementation ownership:** `electron/dev/snapshot.ts`, `electron/dev/capture.ts`, `tests/agent-corpus-boundary.test.ts`.

**Required change:** Add realistic small fixtures for React, PHP, Python, mixed monorepos, empty projects and unrelated projects. Include named files that exist, missing files, sibling projects and conflicting stack clues. Maintain fixture hashes and expected evidence IDs. Exercise retrieval and subsequent tool reads in a separate tier.

**Acceptance criteria:** Generic questions remain stable across unrelated fixtures; repository questions retrieve the intended file and exclude siblings. Missing-target cases report absence rather than using a similarly named unrelated file.

### LR-028 — Persist a reproducible interpretation trace

**Priority:** P2. **Evidence:** Observed diagnostic limitation.

Route decisions record heuristicRule and fallback, but artifact=explanation does not explain which requested-code clause was rejected. Q14 is easy to inspect manually but expensive to diagnose in bulk.

**Implementation ownership:** `src/shared/task-contract.ts`, `src/shared/task-interpretation.ts`, `src/shared/eris-dev.ts`.

**Required change:** Emit versioned evidence for artifact, destination, scope, worker and each obligation: matched spans, rule IDs, rejected alternatives and confidence source. Record a deterministic decision digest. Avoid exposing hidden chain-of-thought; this is structured program provenance, not model private reasoning. Surface trace differences in comparisons.

**Acceptance criteria:** An engineer can identify why Q14 lacked a producing verb from the record alone. Trace schema changes have migrations; missing trace is explicit. Redaction preserves structure without retaining secret input spans.

### LR-029 — Make qualification UI distinguish reachability, coherence and correctness

**Priority:** P1. **Evidence:** Observed misleading success risk.

The export correctly says no-findings and not-evaluated, but zero defects can still appear conclusive while confirmed contract contradictions exist.

**Implementation ownership:** `src/eris-dev/main.tsx`, `src/shared/eris-dev.ts`, `electron/dev/main.ts`.

**Required change:** Show distinct counters for reached boundary, structurally valid, invariant findings, gold-label disagreements, inference completed and behavior verified. Include denominators and not-run states. Link each failure to the exact request and expectation. Do not turn missing labels or absent answers into green checks.

**Acceptance criteria:** A capture-only run displays answer quality as not evaluated even when every request succeeds. Injected gold disagreements are visible and exportable. Overall release status is policy-derived from required tiers, not raw captured count.

### LR-030 — Compare semantic outcomes with controlled provenance

**Priority:** P2. **Evidence:** Evidence limitation.

This file identifies commit 363ddf0, dirtyDigest b8a30555e614d5f1 and routing/prompt .5. It matches the previously reported route distribution, but a distribution match does not prove identical prompts or a newly introduced regression.

**Implementation ownership:** `src/shared/eris-dev-compare.ts`, `electron/dev/runs.ts`, `electron.dev.config.ts`.

**Required change:** Compare by stable question identity and variant, then classify changes in artifact, scope, obligations, authority, prompt and tool schemas. Require compatible fixture/settings/harness metadata for causal attribution. Store a patch/build manifest so a dirty digest can be resolved to actual source changes. Preserve baseline artifacts without claiming mismatched runs are controlled experiments.

**Acceptance criteria:** A scope-only or obligation-only regression is visible despite unchanged intent. Confounded comparisons are labeled. Exact build reproduction requires more than a hash that cannot be resolved to source.

### LR-031 — Scale audit artifacts without duplicating full prompts

**Priority:** P2. **Evidence:** Measured size; optimization proposal.

The export is 126,446,112 bytes for 10,000 records, with repeated prompts, schemas and full tool manifests. This review analyzer loads records and is an offline utility, not a production streaming-memory benchmark.

**Implementation ownership:** `electron/dev/main.ts`, `electron/dev/runs.ts`, `src/shared/eris-dev-compare.ts`.

**Required change:** Introduce versioned content-addressed dictionaries for repeated immutable prompt blocks and schemas, plus per-case references and hashes. Offer streaming JSONL and compressed export while preserving a self-contained expanded form for debugging. Compare incrementally with indexed content IDs and bounded pages; benchmark peak memory on realistic runs.

**Acceptance criteria:** Expanded and compact exports normalize to identical canonical requests. Interrupted export never replaces the previous valid file. Memory limits and corrupted/missing dictionary references have deterministic errors.

### LR-032 — Make CI run completion and cleanup deterministic

**Priority:** P1. **Evidence:** Previously observed harness issue; not caused by this export.

The earlier CI review identified a 1,200-case test polling roughly four seconds, followed by export while work remained and cleanup removing the active run directory. This is separate evidence, not a new JSONL finding.

**Implementation ownership:** `tests/eris-dev-followup.test.ts`, `electron/dev/main.ts`.

**Required change:** Await a run-completed/drained condition with a meaningful overall deadline instead of a fixed short polling count. In teardown cancel and await all background work before deleting fixtures. Give export tests independent completed fixtures. Preserve failure artifacts when cleanup cannot safely finish.

**Acceptance criteria:** The test remains stable on slow filesystem runners; no background progress writes happen after teardown. Timeout produces a diagnostic result and clean drain. Repeat only the affected harness tests under controlled delay before widening CI.

## Delivery order and integration constraints

1. **Contract coherence first:** LR-001, LR-002, LR-012 and LR-014. Add independent failing fixtures for Q1 and Q28, then ensure scope survives compilation. These are foundational; tool minimization alone does not fix contradictory acceptance criteria.
2. **Artifact preservation:** LR-003 through LR-010 and LR-016. Add reviewed labels for the concrete cohorts. Refactor toward a single artifact decision so bypass, fallback and final routing cannot disagree. Keep current authority guards and the prior code-example mutation fixes intact.
3. **Detection and observability:** LR-017 through LR-020, LR-028 through LR-030. Report semantic disagreements separately from transport success. Produce before/after evidence by stable ID and reviewed expectation.
4. **Model and execution qualification:** LR-021 through LR-027. Start with bounded representative fixtures and actual supported adapters; widen only after diagnostics and cancellation are reliable. Measure code quality with executable behaviors, not presence of keywords.
5. **Efficiency and harness reliability:** LR-013, LR-015, LR-026, LR-031 and LR-032. Fix the CI cleanup race before expanding disk-heavy qualification. Measure performance on identical fixture/model/hardware and avoid overlapping unrelated builds.

Use dedicated work branches and PRs into dev under the repository workflow. This review does not authorize a direct push to dev/main, changing models, running paid inference, or changing user settings. The requested deliverable is documentation; application source has not been modified by this review.

## Regression controls that must survive the work

Preserve the earlier fixes for code-example requests acquiring edit permission, quoted commands being treated as direct instructions, recommendation truncation, source-versus-target language confusion, redaction and request capture provenance. Preserve the distinction between tool-free answers and actual execution. Do not reintroduce verification requirements when the user prohibits running checks. Maintain model-produced JSON examples as answer content unless they are valid executable tool protocol in the applicable transport.

A route distribution is not a golden truth. The current 2,811 plan outcomes are exactly where much of the remaining ambiguity sits; tests should not lock that count forever. Likewise, zero edit/run is a property of this run, not an appropriate expected outcome for an authorized coding benchmark. Add positive edit/run fixtures so safety improvements cannot silently disable useful coding behavior.

The previous implementation-status document marked FR-002 and FR-005 as fixed; this review does not establish their return. It does establish residual scope/prompt incoherence and incomplete artifact recognition. FR-038–044 already acknowledged holdout, executable rubric, real model, child lifecycle and UI/provider coverage gaps. LR-018–027 expand those known gaps into concrete delivery requirements rather than representing them as newly introduced regressions.

## Release acceptance proposal

The deterministic gate should require complete, parseable captures, no unauthorized effect escalation, no confirmed scope/acceptance contradictions on gold cases, all explicit output components retained, and no regression in reviewed artifact labels. A labeled question may permit multiple worker choices; its artifact, authority and evidence requirements must still be correct. Unknown semantic cases remain review-needed rather than passing by default.

The interaction gate should run explicit review→implement, selected-recommendation, no-edit, no-run, retry, cancellation and child-failure sequences through the production coordinator. A completed coding case needs a substantive intended diff and relevant observed verification, or an explicit unverified outcome when execution was prohibited. Child task completion must be awaited and request delivery must be observable in the production chat UI.

The model gate should disclose the actual model, tokenizer/adapter, fixture, budget, corpus subset and evaluator version. Count model-call failures separately from incorrect answers and harness failures. Compare pass rates by behavior and topic with sufficient sample size; do not invent a universal numeric quality threshold before establishing a trusted baseline. Until that stage runs, publish request coherence results only.

## Review validation performed

Read every JSONL record and validated consecutive indices, unique IDs and unique questions. Inspected production intake, routing/fallback, artifact/obligation extraction, prompt compilation, tool exposure, request invariants and existing corpus tests. Cross-checked concrete examples against the exported model-facing contract and original question. The review did not call any real model or execute generated code. Metrics are reproducible using the included script. A code-quality improvement remains a proposal until its corresponding acceptance criteria pass.
