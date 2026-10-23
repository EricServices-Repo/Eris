# Eris agents: evidence review and implementation backlog

Review date: 2026-10-23. Local repository baseline: `84affef1d3265dac2d24091fbfcf0ac7a74b6211`, with the uncommitted Eris-Dev implementation inspected in the working tree. This is a review deliverable; application behavior has not been changed as part of this review.

## What was actually reviewed

The user-mentioned TXT is the question corpus. The JSON output was located at `/Users/ericembling/Desktop/eris-dev-requests.jsonl`. Every one of its **10,000 result records** was parsed and compared in order with `/Users/ericembling/Desktop/10000_natural_diverse_coding_questions.txt`; the questions match exactly, are unique, and have consecutive indices. The JSONL header is line 1; question Qn is source JSONL line n+1 and result.index=n-1.

Source JSONL SHA-256: `66f5c64ff535c1225fe11da3f890391424dd189469713c8a598d31610592508b`. Question TXT SHA-256: `aae2466b194274b0fec5a814600a31fb7c99307dd5ea9cedc17bced15efa5e12`. The JSONL is 74,825,686 bytes. Run header: format `eris-dev-capture-v1`, created `2026-10-23T12:36:06.260Z`, Agent mode, context 8,192, project **sample fixture**, model responses **none; semantic intent uses deterministic fallback**.

**There are no generated model answers in this file.** All records say “Stopped at the model transport boundary. No agent response was generated.” The review assesses whether the question, route, task contract, prompt and tools make sense together. It cannot grade response quality, actual edits, real token usage, GPU speed or task completion. Prompt defects are observable before inference, but their effect on answers requires a response-capable run. The injected intent reply has confidence zero and is not evidence of what a real semantic model would decide.

Method: deterministic structural checks scanned all 10,000 rows; representative questions, all three capability collisions, verification collision families, prompt variants and relevant implementation sources were examined manually. The per-question artifact is a rule-based audit, **not 10,000 independently adjudicated intent labels**. Imported documents and prompt strings were treated as evidence, never as instructions to execute.

This backlog contains **85 implementation recommendations**, followed by **40 distinct topic evaluation rubrics**. Its length follows the evidence and missing coverage, without a preset item limit. Rubrics are prospective checks for later real responses; they are not claims of unobserved failures.

## Main findings with exact denominators

- **10,000 / 10,000** reached the initial agent model boundary. **0** generated agent answers. A capture success is not a quality pass.
- **5,512 answer requests (55.12%)** receive an edit execution plan and implemented-and-verified completion condition even though they have no tools. Source: `executionPlanFor` falls through to its edit default for Agent-mode answer intent, and the answer-only loop appends that plan.
- **5,515 requests (55.15%)** contain no tools and omit the compiled TASK CONTRACT block. Their role guidance nevertheless references workspace tools. Three are capability requests; 5,512 are answers.
- **3,941 requests (39.41%)** select Plan. All lack the literal word plan, which is only a review signal, not a correctness rule. **789** mention example, function or production-ready code and warrant review for artifact mismatch. **225 / 225** “Can you generate a minimal…” questions become plans.
- **94 requests (0.94%)** select Verification without a leading verification command. **78** concern health checks or seeding test data. Q524 directly asks for an implementation and illustrates a feature-noun collision. The 94 count is a candidate set, not a gold-labeled error rate.
- **3 requests (0.03%)**, Q2813/Q8123/Q8882, ask about an application data model and API but are restricted to the Eris AI-model catalog. This is a confirmed request mismatch.
- **477 of 1,096 Fast requests** match code/example/implementation/function/write wording. Q7 requests Java code but Fast is told to reply in one to three sentences. This is a response-depth review set, not proof of an incorrect generated answer.
- **4,485 tool-worker prompts** repeat the shared-rules block twice.
- **131 Composer edit requests** expose `generate_image` despite images being disabled in capture settings; all omit an initially visible `run` tool while their instructions require verification. Automatic verification exists elsewhere in the loop, so this is an initial prompt/tool mismatch rather than proof that checks never run. Align the instructions without granting unrestricted shell authority.
- **8,838 intent-model requests** are simulated with confidence zero; **1,162** turns skip that request. The total transport request count is **18,838**, not 10,000 model responses.
- All rows have null thread IDs, zero recommendations, no selected skills, one project ID and no tool/response cycles. Thus they do not validate follow-up references, delegation, real project reasoning or final outcome relevance.

Agent distribution: Explainer 4,738; Plan 3,941; Fast 1,096; Composer 131; Verification 94. Intent distribution: answer 5,512; plan 3,941; explore 319; edit 131; verify 94; capability 3. Reviewer is never selected; the corpus lacks explicit review workloads, so that fact alone is not an agent defect.

Capture durations: min 0 ms, median 1.0 ms, p95 17 ms, max 156 ms. These measure scripted pre-inference work. They are not model latency or tokens/second.

## Concrete question-to-request examples

- **Q2** (JSONL line 3): “Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?” → **Plan / plan**.
- **Q6** (JSONL line 7): “Can you write per-user rate limiting so the happy path is obvious and errors are explicit?” → **Explainer / answer**.
- **Q7** (JSONL line 8): “Can you write a clear Java version of generating image thumbnails on the fly?” → **Fast / answer**.
- **Q34** (JSONL line 35): “Write a TypeScript implementation of cache invalidation after data changes that prioritizes clarity?” → **Explainer / answer**.
- **Q42** (JSONL line 43): “I need to implement transactional emails using templates with good test coverage. How would you approach it?” → **Verification / verify**.
- **Q107** (JSONL line 108): “I want request validation middleware to be easy to reason about. How would you write it?” → **Composer / edit**.
- **Q111** (JSONL line 112): “Show me an example of health checks that verify downstream dependencies inside a Django project?” → **Verification / verify**.
- **Q524** (JSONL line 525): “Write a TypeScript implementation of seeding realistic test data that prioritizes clarity?” → **Verification / verify**.
- **Q2813** (JSONL line 2814): “How would you design the data model and API for infinite scroll using cursor pagination?” → **Explainer / capability**.
- **Q8123** (JSONL line 8124): “How would you design the data model and API for transactional emails using templates?” → **Explainer / capability**.
- **Q8882** (JSONL line 8883): “How would you design the data model and API for role-based access control?” → **Explainer / capability**.

For Q2 the requested artifact is a working TypeScript example of soft delete/restore. A reasonable no-write fallback can still deliver that example in chat. A contract that requires only a future implementation plan changes the requested artifact even though it can be conservative about file writes.

For Q524 “test data” describes data to create. It is not an instruction to validate an existing implementation. For the three capability collisions, “data model and API” refers to application design; limiting the answer to installed AI models cannot answer the question.

For Q6/Q34 the answer route itself can be valid for code in chat. The confirmed defect is the contradictory mutation-and-verification plan attached to a tool-free answer. The required fix is coherent delivery, not indiscriminately routing all writing words to repository mutation.

## Controlled wording families worth labeling

- “Can you write … so the happy path …”: 40 questions → 36 answer, 4 edit.
- “I want … to be easy to reason about. How would you write it?”: 40 → 40 edit.
- “Help me turn the requirement … into production-ready code?”: 40 → 38 answer, 2 verify.
- “Can you generate a minimal …”: 225 → 225 plan.
- “How would you design the data model and API …”: 40 → 37 answer, 3 capability.
- “Write a … implementation … that prioritizes clarity?”: 222 → 199 answer, 17 edit, 6 verify.
- “Can you write a clear …”: 230 → 212 answer, 18 edit.

These families demonstrate sensitivity to feature wording and grammatical form. Alternative routes may be acceptable if artifact and authority remain correct; labels must not simply demand one agent name for every case.

## How another model should implement this backlog

Evidence labels mean: **confirmed defect** is directly visible in the request or source; **review candidate** is a heuristic-selected population needing adjudication; **source-supported** describes an implementation limitation; **validation gap/design improvement** is a requirement to measure future behavior. Do not convert candidate counts into failure rates.

P0 means correctness or release-critical regression; P1 means important reliability, architecture or evaluation work; P2 means optimization or review usability. Priorities are recommendations, not claims that every item independently blocks every release.

Each item has a stable ID, source targets, evidence, concrete implementation guidance, acceptance behavior and dependencies. Dependencies identify logical prerequisites, not permission to make unrelated changes. Paths are review entry points; verify the current source before editing. Preserve the production task gateway, scope binding and cancellation guards. Reuse the existing debug-runs/eval systems rather than implementing parallel orchestration engines.

Suggested implementation order:

1. **Stop contradictory requests:** AG-001/002/006/007/023/026/037, with focused negative/positive cases.
2. **Separate artifacts from effects:** AG-003/004/005/008/010/011/012, then resolver trace/precedence AG-013–022.
3. **Consolidate prompts and capabilities:** AG-024–042, preserving all authority limits.
4. **Collect representative evidence:** AG-043–051 and AG-059–070; distinguish request validity from answer quality.
5. **Prove follow-ups and coordination:** AG-052–058; these need actual multi-turn/replay cases.
6. **Qualify real completion and releases:** AG-071–085, selecting compact regressions first and expanding full sweeps when meaningful.

Do not execute all 10,000 questions against paid or local models merely to satisfy a count. Define response-capable modes, budgets and representative fixtures first; use explicit live-run configuration and normal resource admission. The user requested this review artifact, not a live inference sweep.

## Detailed implementation backlog

## A. Deliverable and intent correctness

### AG-001 — Give answer intent its own execution plan · P0

**Evidence class:** confirmed defect.

**Evidence and impact:** All 5,512 answer records receive “Make the requested changes” and an implementation/verification completion condition. Their initial tool lists are empty. Q6 is a direct example.

**Implementation:** Add an explicit answer branch to executionPlanFor before the edit default. Plans for answers must describe answering the question or delivering the requested example. Preserve edit plans only for patch deliverables.

**Acceptance:** Q6, Q7, Q8 and Q34 have no mutation or verification requirement merely because Agent mode is selected; an explicit edit still receives an edit plan.

**Start in:** `electron/main/services/chat-router.ts`; `tests/chat-router.test.ts`. **Dependencies:** None; can start independently.

### AG-002 — Make acceptance criteria agree with deliverable and authority · P0

**Evidence class:** confirmed defect.

**Evidence and impact:** 5,643 contracts use the generic implemented-and-verified criterion: 5,512 answers plus 131 edits. Answer contracts prohibit execution and mutation.

**Implementation:** Generate acceptance criteria from deliverable and requested behavior, then validate that satisfying them is possible under task authority. Reject internally impossible contracts before inference.

**Acceptance:** An answer contract with no edit authority cannot require a file mutation. A code sample is accepted for sample correctness rather than workspace changes.

**Start in:** `electron/main/services/task-intake.ts`; `src/shared/task-contract.ts`; `tests/task-meaning.test.ts`. **Dependencies:** AG-001

### AG-003 — Represent the requested artifact independently from worker intent · P0

**Evidence class:** design change grounded in observed routing.

**Evidence and impact:** The corpus requests examples, implementation, explanations, plans and tests, but the contract has no code-example or design artifact. This collapses distinct requests into answer, plan or patch.

**Implementation:** Add a typed requestedArtifact such as explanation, code-example, design, plan, review, patch or execution-report. Keep topic, target language, scope binding and effect authority separate. Migrate contracts with compatibility defaults.

**Acceptance:** “Generate a complete TypeScript example” produces a code-example artifact; “apply it in src/auth.ts” produces a patch; both can use coding expertise without conflating their effects.

**Start in:** `src/shared/task-contract.ts`; `electron/main/services/task-intake.ts`; `electron/main/services/task-resolver.ts`; `electron/main/services/chat-turn.ts`. **Dependencies:** AG-002

### AG-004 — Distinguish writing code in chat from editing repository files · P0

**Evidence class:** review candidate with strong evidence.

**Evidence and impact:** Q2 asks for a minimal complete example; Q107 asks “How would you write it?” The latter has edit authority, while many explicit “Can you write” questions have none. Wording alone does not establish the intended destination.

**Implementation:** Resolve artifact destination as chat, existing workspace or new project. Infer explicit file/application edits from request and context; use code examples for self-contained examples. Expose material ambiguity instead of silently selecting a destination.

**Acceptance:** Contrasting examples “show a function”, “add the function to api.ts” and “build a new app here” retain distinct destinations and effect grants.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/main/services/task-intake.ts`; `src/shared/task-contract.ts`. **Dependencies:** AG-003

### AG-005 — Stop replacing requests for complete examples with read-only plans · P0

**Evidence class:** confirmed request mismatch with candidate population.

**Evidence and impact:** 789 Plan records contain example, function or production-ready-code wording. All 225 requests beginning “Can you generate a minimal…” route to Plan, including Q2. The 789 rule is a candidate filter, not an independently labeled error count.

**Implementation:** Make explicit requested output outrank the resolver fallback category. A conservative no-write result should still permit a complete code example rather than forcing a plan. Label this regression family independently.

**Acceptance:** Q2 produces a usable TypeScript example with restore behavior, or a justified clarification, rather than only a sequence of future implementation steps.

**Start in:** `electron/main/services/task-resolver.ts`; `src/shared/agent-contract.ts`; `electron/main/services/chat-router.ts`. **Dependencies:** AG-003, AG-004

### AG-006 — Separate requested verification from test-related feature nouns · P0

**Evidence class:** confirmed routing defect with candidate population.

**Evidence and impact:** 94 records select Verification without a leading verification command; 78 involve “health checks that verify downstream dependencies” or “seeding realistic test data”. Q524 asks to write an implementation but gets Verification.

**Implementation:** Parse the requested action and its object. A relative clause describing a feature and an adjective describing test data must not become the controlling action. Keep requests to actually verify existing code on Verification.

**Acceptance:** Q111, Q524, Q2286 and Q3493 request examples or implementations; “verify this implementation” still selects verification. Run/verify differences remain explicit.

**Start in:** `src/shared/agent-contract.ts`; `electron/main/services/chat-router.ts`; `electron/main/services/task-resolver.ts`; `tests/agent-contract.test.ts`. **Dependencies:** None; can start independently.

### AG-007 — Disambiguate application data models from Eris model capabilities · P0

**Evidence class:** confirmed routing defect.

**Evidence and impact:** Q2813, Q8123 and Q8882 ask how to design a data model and API. All three route to capability, whose prompt restricts the answer to the Eris AI model catalog.

**Implementation:** Require evidence that model refers to an inference model, provider or installed model before selecting capability. Give schema/data-model/API-design phrases their domain meaning; do not rely on a broad model/use proximity expression.

**Acceptance:** These three questions retain application design intent. “Which models are installed in Eris?” continues to use the current model catalog.

**Start in:** `electron/main/services/chat-router.ts`; `tests/chat-router.test.ts`. **Dependencies:** None; can start independently.

### AG-008 — Use an artifact-capable worker for substantive code requests · P1

**Evidence class:** review candidate.

**Evidence and impact:** 477 Fast records match write/example/implementation/function/code wording. Q7 asks for Java thumbnail code, while Fast is instructed to reply in one to three sentences and redirect edits to Composer.

**Implementation:** Select worker expertise and response depth from the requested artifact. A code example needs enough space for the implementation, dependencies and limitations even when workspace mutation is not requested.

**Acceptance:** Q7 returns an appropriately sized Java example; a short symbol-location lookup remains brief. Do not require a handoff merely to write code in chat.

**Start in:** `src/shared/agent-contract.ts`; `resources/agents.json`; `electron/main/services/chat-router.ts`. **Dependencies:** AG-003

### AG-009 — Replace character-length worker selection with complexity features · P1

**Evidence class:** source-supported design weakness.

**Evidence and impact:** chatAgentForTurn selects Fast for short text under 80 characters unless particular explanation words occur. Code intent can remain unchanged across short and long paraphrases.

**Implementation:** Use artifact, number of constraints, need for source evidence and task complexity to select a worker. Keep length as an optional signal rather than a decision boundary.

**Acceptance:** Add short and verbose paraphrases of the same complete-example request; deliverable, authority and answer depth remain equivalent.

**Start in:** `src/shared/agent-contract.ts`; `electron/main/services/chat-router.ts`. **Dependencies:** AG-008

### AG-010 — Preserve all clauses in combined implementation and test requests · P1

**Evidence class:** coverage and design gap.

**Evidence and impact:** The corpus includes “Write the core logic and the tests…” and implementation requests with good test coverage. A single coarse verify label can erase the implementation obligation.

**Implementation:** Extract ordered deliverables and constraints before agent choice. Model implementing plus testing as a patch/sample with a verification requirement, rather than substituting verification for implementation.

**Acceptance:** A core-logic-and-tests request has both obligations and an observable completion check for each. Failure to provide one cannot be counted as complete.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/main/services/task-intake.ts`; `src/shared/task-contract.ts`. **Dependencies:** AG-003, AG-006

### AG-011 — Make plan selection require a planning deliverable · P1

**Evidence class:** review candidate.

**Evidence and impact:** All 3,941 Plan records lack the explicit word plan. Some approach questions may validly receive plans, so this count is not a failure rate; complete-example requests demonstrate over-selection.

**Implementation:** Use requested artifact and conversational purpose to distinguish advice, design, step-by-step planning and implementation. Preserve an advice request as advice without requiring named workspace edits.

**Acceptance:** A general “What is the best way?” question can receive a reasoned approach; “give me an implementation plan” receives ordered workspace steps; Q2 still receives code.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/main/services/chat-router.ts`; `src/shared/agent-contract.ts`. **Dependencies:** AG-003, AG-005

### AG-012 — Publish one resolved task interpretation for every consumer · P1

**Evidence class:** source-supported architecture gap.

**Evidence and impact:** Initial classification, explicit-specialist overrides, semantic re-resolution, execution-plan generation and worker workflow all interpret related intent signals. They can disagree while using the same original question.

**Implementation:** Produce a typed intake decision with artifact, destination, authority and provenance. Route workers, build plans, compile prompts and score completion from that decision rather than re-reading keywords independently.

**Acceptance:** A trace identifies one final decision revision used by prompt, worker and outcome evaluator; downstream stages cannot silently reinterpret the deliverable.

**Start in:** `electron/main/services/chat-turn.ts`; `electron/main/services/chat-router.ts`; `electron/main/services/task-resolver.ts`; `electron/main/services/task-intake.ts`. **Dependencies:** AG-003

## B. Resolver reliability and observability

### AG-013 — Correct the simulation event that claims the fallback is retained · P1

**Evidence class:** confirmed diagnostic defect.

**Evidence and impact:** 8,838 captured intent calls receive confidence zero. The event says “retain deterministic routing”, but resolveTaskIntent changes an edit fallback to plan and a run fallback to explore at its final return.

**Implementation:** Record initial intent, simulated resolver reply and final intent separately. Describe the conservative downgrade explicitly; do not attribute the resulting route to the live semantic model.

**Acceptance:** Q2 trace explains initial edit versus final plan and the fallback rule that changed it; the export does not claim the deterministic edit route was retained.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/task-resolver.ts`; `src/shared/eris-dev.ts`. **Dependencies:** None; can start independently.

### AG-014 — Capture a structured route decision trace · P1

**Evidence class:** confirmed export limitation.

**Evidence and impact:** The export has final agent/intent and a prose route event, but no complete rule matches, precedence, resolver validity or reason for a changed route.

**Implementation:** Export candidates, matched rule IDs/spans, initial intent, resolver request/reply source, final intent, worker selection reason and final permission intersection. Use stable rule IDs rather than matching prose strings.

**Acceptance:** An evaluator can explain why Q524 became verify and why Q2813 became capability without running a debugger.

**Start in:** `electron/main/services/chat-router.ts`; `electron/main/services/task-resolver.ts`; `electron/dev/capture.ts`; `src/shared/eris-dev.ts`. **Dependencies:** AG-012, AG-013

### AG-015 — Audit semantic-resolver bypass conditions · P1

**Evidence class:** source-supported weakness.

**Evidence and impact:** resolveTaskIntent returns early for explicit-looking helper matches and several “Can you write/build…” phrases. Erroneous heuristic matches can therefore avoid semantic correction entirely.

**Implementation:** Keep a small set of high-confidence bypasses with documented negative cases. Measure false bypasses with independently labeled contrast pairs. Record which shortcut was taken.

**Acceptance:** A feature noun containing test or verify does not suppress resolution of the actual requested action. Legitimate clear edit commands still avoid unnecessary inference.

**Start in:** `electron/main/services/task-resolver.ts`; `src/shared/agent-contract.ts`. **Dependencies:** AG-006, AG-014

### AG-016 — Prevent heuristic overrides from undoing a resolved interpretation · P1

**Evidence class:** source-supported design weakness.

**Evidence and impact:** planChatTurn accepts resolvedIntent but later explicitSpecialistIntent can overwrite it. A false asksForVerification match may survive re-planning even after meaning has been resolved.

**Implementation:** Define precedence and validate explicit constraints once at intake. Worker re-planning may change expertise or models while preserving the resolved artifact and authority revision.

**Acceptance:** A valid resolved code-example interpretation for a health-check question is not changed back to verify during worker selection.

**Start in:** `electron/main/services/chat-router.ts`; `electron/main/services/chat-turn.ts`. **Dependencies:** AG-012, AG-015

### AG-017 — Budget resolver latency as a measured phase · P1

**Evidence class:** validation gap.

**Evidence and impact:** The capture durations use a scripted resolver, typically completing in milliseconds. The real semantic resolver has a 10-second timeout, which this run does not exercise.

**Implementation:** Expose resolver queue, inference and timeout timings separately. Add a per-turn deadline shared across intake and execution, with a documented fallback and cancellation propagation.

**Acceptance:** A slow or unavailable resolver terminates within the configured intake budget and reports the fallback. Scripted capture timing is never shown as live latency.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/dev/capture.ts`; `electron/main/services/task-deadline.ts`. **Dependencies:** None; can start independently.

### AG-018 — Validate semantic decisions with the same runtime schema as task intake · P1

**Evidence class:** source-supported design improvement.

**Evidence and impact:** The resolver requests a JSON schema but parses the response into a TypeScript cast and then performs selected checks. Provider compliance is not guaranteed.

**Implementation:** Use a shared runtime schema for intent/artifact interpretation. Reject extra or invalid fields, malformed confidence and incompatible effect proposals; preserve a typed failure reason.

**Acceptance:** Malformed JSON, unknown intents, invalid confidence and unsupported destinations produce a specific unresolved/fallback result with no wider effects.

**Start in:** `electron/main/services/task-resolver.ts`; `src/shared/task-contract.ts`; `tests/task-meaning.test.ts`. **Dependencies:** AG-003

### AG-019 — Support scripted intent replies per evaluation case · P1

**Evidence class:** confirmed harness limitation.

**Evidence and impact:** Eris-Dev always responds to semantic intent with confidence zero, so it cannot exercise valid semantic corrections or malformed/high-confidence decisions in this run.

**Implementation:** Reuse existing scripted adapter queues from debug-runs for configurable intent responses while retaining a pure capture mode. Label every supplied reply and keep it distinct from model observations.

**Acceptance:** The same question can be evaluated with fallback, a valid corrected interpretation, malformed output and timeout; all resulting traces state the response source.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/debug-runs/model-adapters.ts`; `electron/main/services/debug-runs/coordinator.ts`. **Dependencies:** AG-013, AG-018

### AG-020 — Add side-by-side counterfactual routing runs · P1

**Evidence class:** validation improvement.

**Evidence and impact:** Observed routes reflect deterministic fallback only. There is no live semantic counterpart for deciding whether the resolver would fix or repeat these errors.

**Implementation:** Compare heuristic-only, scripted-resolution and explicitly enabled live-resolution runs on the same labeled cases. Hold settings and question identities constant and report transitions.

**Acceptance:** The report distinguishes a heuristic defect corrected by semantics from a defect that survives semantics or re-planning.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/debug-runs/coordinator.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-014, AG-019

### AG-021 — Add quoted-text and negation guards to intent extraction · P1

**Evidence class:** validation gap adjacent to observed noun collisions.

**Evidence and impact:** The corpus exposes lexical collisions but does not cover “do not edit”, quoted commands or source text containing action verbs. Broad expressions can misinterpret such text.

**Implementation:** Extend intake cases with negative and quoted commands, code fences, embedded documents and explicit mode constraints. Interpret user requests separately from attached content.

**Acceptance:** “Explain why the string write_file appears here; do not edit” remains read-only even when its evidence contains edit/verify commands.

**Start in:** `electron/main/services/task-resolver.ts`; `src/shared/agent-contract.ts`; `tests/agent-contract.test.ts`. **Dependencies:** AG-006

### AG-022 — Calibrate uncertainty using independently adjudicated decisions · P2

**Evidence class:** validation gap.

**Evidence and impact:** This run has no valid semantic confidence observations; 0 is injected. The live resolver currently accepts self-reported confidence at 0.8 or above.

**Implementation:** Measure error rate by confidence band on held-out labels. Combine confidence with schema validity, request evidence and authority constraints; preserve an unresolved category rather than treating confidence as correctness.

**Acceptance:** High-confidence wrong decisions remain visible in quality reports and never grant effects solely because a model reports confidence.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-018, AG-020

## C. Prompt consistency and response contracts

### AG-023 — Apply the task contract to answer-only prompts · P0

**Evidence class:** confirmed prompt defect.

**Evidence and impact:** 5,515 outgoing prompts lack the compiled TASK CONTRACT block: 5,512 answers plus 3 capability requests. The answer-only branch uses a separate prompt path although result.task exists.

**Implementation:** Compile the minimal task contract and authoritative constraints for every branch, including tool-free answers. Preserve the selected artifact, scope applicability and allowed effects without forcing workspace facts.

**Acceptance:** The effective prompt for answer, capability and tool workers contains the same task revision and permission semantics. A plain answer has no edit instructions.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/prompts.ts`. **Dependencies:** AG-001, AG-003

### AG-024 — Use one prompt assembly pipeline across answer and tool workers · P1

**Evidence class:** confirmed architectural inconsistency.

**Evidence and impact:** Tool workers use compileTaskContext; answer-only workers append routing and execution-plan prose to buildChatMessages. This divergence produces the 5,512 contradictory answer plans.

**Implementation:** Create shared typed prompt blocks and branch-specific selections. Apply the same validation and context manifest regardless of tools; remove independently appended authority-like prose.

**Acceptance:** A cross-product test of intents, Ask/Agent mode and worker profiles shows consistent task identity, constraints and artifact instructions.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/chat-prompt.ts`; `electron/main/services/agent/prompts.ts`; `electron/main/services/agent/context-compiler.ts`. **Dependencies:** AG-023

### AG-025 — Deduplicate shared rules and worker role instructions · P1

**Evidence class:** confirmed prompt waste.

**Evidence and impact:** 4,485 prompts repeat “Shared rules (every role inherits these)” twice. Worker context includes global instructions plus priorSystem containing the same global instructions.

**Implementation:** Assemble global rules, task, role, workspace evidence and optional skills exactly once from typed sources. Deduplicate by block identity before budgeting, not by brittle text replacement.

**Acceptance:** All 4,485 tool-worker cases include one shared-rules block and one role block; no permission or requested behavior is lost.

**Start in:** `electron/main/services/agent/prompts.ts`; `electron/main/services/chat-prompt.ts`; `electron/main/services/agent/context-compiler.ts`. **Dependencies:** AG-024

### AG-026 — Reject prompts that require unavailable actions · P0

**Evidence class:** confirmed prompt/capability mismatch.

**Evidence and impact:** 5,515 tool-free requests still mention read_file/retrieve. Answer prompts demand edits; Composer asks for verification with no initially visible run tool. The consequences differ, but the inconsistencies are observable.

**Implementation:** Add a pre-inference prompt manifest validator linking required actions to tools and authority. Distinguish optional discoverable tools from impossible actions and intentionally disabled capabilities.

**Acceptance:** A model request either contains a feasible response contract or returns a specific compiler diagnostic before inference. Optional reads are described conditionally.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/loop.ts`; `electron/main/services/tool-registry.ts`. **Dependencies:** AG-023, AG-037

### AG-027 — Remove write-tool examples from read-only role guidance · P1

**Evidence class:** confirmed distracting prompt content.

**Evidence and impact:** Plan and Verification prompts include write_file examples and the empty-project create-files directive, immediately alongside “Do not edit”. Authority may block writes, but the prompt creates avoidable conflict.

**Implementation:** Generate examples and workflow instructions from effective authority. Read-only roles receive read/analysis examples and a clear non-mutation completion rule.

**Acceptance:** Plan/Verification prompts contain no imperative to create files or example invoking write_file; edit roles retain concrete edit guidance.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/prompts.ts`. **Dependencies:** AG-024

### AG-028 — Select one declared tool-call protocol for the active backend · P1

**Evidence class:** source-supported design improvement.

**Evidence and impact:** Compiled prompts tell models to use native calls or a text envelope, while other prompt constants also accept markdown JSON fences and flattened argument examples.

**Implementation:** Render protocol guidance from the active adapter capability. Use a canonical arguments object, preserve call IDs and test exact native/text serialization. Do not suggest multiple competing formats within a request.

**Acceptance:** Native requests contain native instructions only; compatibility requests have one envelope grammar with examples matching the parser. No arbitrary explanatory JSON becomes a call.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/prompts.ts`; `electron/main/services/model-protocol.ts`; `electron/main/services/agent/tool-parsing.ts`. **Dependencies:** None; can start independently.

### AG-029 — Render a response contract that matches the requested artifact · P1

**Evidence class:** confirmed response-guidance gap.

**Evidence and impact:** Plan always requires ordered steps, Fast restricts length, and answer falls through to edit completion. None specifies how to deliver a complete code example versus a design answer.

**Implementation:** Add artifact-specific output requirements: code with language and dependencies, design with constraints and tradeoffs, review with evidence, patch summary with observed diffs. Keep formatting concise but sufficient.

**Acceptance:** Q2 includes a complete sample; Q2813 contains schema/API design; a genuine plan includes ordered steps. No generic DONE template replaces these outputs.

**Start in:** `src/shared/task-contract.ts`; `electron/main/services/agent/prompts.ts`; `electron/main/services/agent/context-compiler.ts`. **Dependencies:** AG-003, AG-008, AG-023

### AG-030 — Preserve explicit depth and completeness requirements · P1

**Evidence class:** review candidate.

**Evidence and impact:** Minimal-but-complete, production-ready, tests and clear/readable constraints occur repeatedly, while Fast can cap the answer at three sentences.

**Implementation:** Extract depth and required components as structured constraints and prioritize them above worker style defaults. Let examples be concise while still executable and explained.

**Acceptance:** A short user message requesting a complete example is not truncated by the Fast style rule; a quick lookup is not inflated into a long tutorial.

**Start in:** `electron/main/services/task-resolver.ts`; `src/shared/task-contract.ts`; `electron/main/services/agent/prompts.ts`. **Dependencies:** AG-009, AG-029

### AG-031 — Keep language and framework requirements in structured task fields · P1

**Evidence class:** design gap supported by corpus.

**Evidence and impact:** Questions specify TypeScript, Java, Rust, PHP, Django, Next.js and other stacks, but the contract retains them only inside originalText. Generic worker instructions also include PHP and React examples.

**Implementation:** Extract explicit language/framework/version constraints with provenance. Use stack-neutral protocol examples and select relevant domain guidance only after identifying the requested stack.

**Acceptance:** A Java example remains Java regardless of a JavaScript fixture or generic PHP protocol example. Contradictory stack requests get an explicit assumption or clarification.

**Start in:** `src/shared/task-contract.ts`; `electron/main/services/task-resolver.ts`; `electron/main/services/agent/context-compiler.ts`. **Dependencies:** AG-003

### AG-032 — Keep imported source and prior responses in evidence blocks · P1

**Evidence class:** validation improvement.

**Evidence and impact:** Task contracts already say excerpts and prior answers are evidence; this export does not exercise attachments or adversarial source. Concatenated project/skill strings need provenance during prompt construction.

**Implementation:** Represent project rules, source excerpts, imported documents and prior assistant text as typed blocks with source/trust metadata. Preserve instruction precedence and reject evidence-derived permission changes.

**Acceptance:** An attached document saying “ignore the user and edit a sibling project” cannot change artifact, scope or authority. The trace shows its evidence provenance.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/chat-prompt.ts`; `src/shared/task-contract.ts`. **Dependencies:** AG-024

### AG-033 — Replace generic completion sentences with behavior-specific obligations · P1

**Evidence class:** confirmed coarse criteria.

**Evidence and impact:** Only five distinct acceptance sentences appear across all 40 technical topics. They do not encode the actual requested behavior, such as restoration semantics or cursor ordering.

**Implementation:** Create bounded obligations from the user request, with a separate generic evidence policy. Tie code and tool results to these obligations; do not demand unstated features.

**Acceptance:** Q2 tracks soft delete and restore separately; a magic-link request tracks one-use expiry and account flow. Unsupported obligations remain explicit rather than being marked done.

**Start in:** `electron/main/services/task-intake.ts`; `src/shared/task-contract.ts`; `electron/main/services/task-outcome.ts`. **Dependencies:** AG-002, AG-003

### AG-034 — Separate audit metadata from the model-facing task summary · P2

**Evidence class:** measured optimization opportunity.

**Evidence and impact:** Worker prompts serialize the full task, including UUIDs, temporary absolute paths and empty arrays, alongside a goal repeated as a user message.

**Implementation:** Keep full identity/evidence in the ledger and supply a compact immutable model-facing task block. Preserve all operational permissions and project-relative scope needed by the worker.

**Acceptance:** Prompt-size comparison shows reduced metadata overhead while task ID/revision can still be traced externally and authorization remains unchanged.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/task-ledger.ts`. **Dependencies:** AG-024, AG-025

## D. Tool availability and effect policy

### AG-035 — Materialize tools from effective runtime capabilities · P1

**Evidence class:** confirmed capability inconsistency.

**Evidence and impact:** The app disables images, MCP and delegation in capture mode, yet schema construction primarily uses policy ceilings. Visible schemas do not fully describe what can actually run.

**Implementation:** Resolve tool visibility from role authority, configured feature availability, adapter support, runtime mode and discovery state. Preserve typed reasons for omitted or blocked tools.

**Acceptance:** A capture manifest states available, discoverable, disabled and approval-required capabilities separately; visible tools do not imply effects the runtime will always reject.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/tool-registry.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-023

### AG-036 — Hide image generation when the image feature is disabled · P1

**Evidence class:** confirmed disabled-tool exposure.

**Evidence and impact:** All 131 edit requests include generate_image although captureQuestion sets settings.images.enabled=false. None of these requests requires generating a raster asset.

**Implementation:** Exclude generate_image when disabled or unsupported. Prefer deferring it until a relevant image request, and explain absence in the capability manifest.

**Acceptance:** The same code-only edit capture has no image schema when disabled. Enabling configured image generation makes the tool discoverable for a relevant task.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/tool-registry.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-035

### AG-037 — Align editing-worker verification instructions with the actual execution path · P0

**Evidence class:** confirmed initial-tool mismatch; full execution needs validation.

**Evidence and impact:** All 131 Composer requests instruct testing/typechecking and have execute=verification, but their initial tool lists omit run. run is full-access in the registry, while edit policy filters it out; Reviewer/Verification get a special run insertion. The loop also has automatic verification later, so initial absence does not prove that no tests would ever run.

**Implementation:** Declare whether verification is automatic or agent-driven. If agent-driven checks are needed, model verification as a separate command capability and expose a restricted command schema with existing gateway validation/approval; otherwise describe the automatic verifier accurately.

**Acceptance:** An edit task can execute an allowed test/typecheck after a patch; an unrelated shell command is rejected. Do not solve this by granting full effects to every edit.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/tool-registry.ts`; `electron/main/services/agent/tool-gateway.ts`; `electron/main/services/command-approval.ts`. **Dependencies:** AG-035

### AG-038 — Report unavailable approvals distinctly from workflow failures · P1

**Evidence class:** confirmed harness limitation.

**Evidence and impact:** Eris-Dev always returns false for command and MCP approvals and stops before tool execution. A future live/replay run needs to distinguish denied/unavailable approval from an agent choosing the wrong action.

**Implementation:** Add explicit approval policy in scenario metadata, record each proposal and decision, and support sandboxed approved verification cases. Never inherit production credentials or permissions silently.

**Acceptance:** A denied test command is reported as blocked approval, not failed test or model stupidity; an approved fixture check records real stdout/stderr and exit status.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/debug-runs/coordinator.ts`; `src/shared/debug-runs.ts`. **Dependencies:** AG-037

### AG-039 — Remove or qualify MCP discovery when no connected tools exist · P2

**Evidence class:** confirmed affordance mismatch.

**Evidence and impact:** All 4,485 tool-bearing requests include search_mcp_tools even though capture uses mcp=off. There is no connected catalog to inspect in this run.

**Implementation:** Provide a capability count and omit unusable discovery affordances. Keep generic built-in search_tools available when relevant. In live diagnostics use explicit fake or consented integrations.

**Acceptance:** MCP-off captures have no misleading connected-tool discovery instruction; fixture MCP tests expose a known deterministic catalog.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/tool-registry.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-035

### AG-040 — Record tool discovery state and its context cost · P1

**Evidence class:** export limitation.

**Evidence and impact:** Initial requests contain 14, 15 or 21 schemas; later discovery is not captured because inference stops. This cannot demonstrate that a missing tool can be discovered or budgeted successfully.

**Implementation:** Export initial, deferred, newly discovered and rejected schemas with step IDs and size estimates. Recompute budgets after discovery and preserve pending tool exchanges.

**Acceptance:** A scripted search_tools turn exposes the intended schema on the next request, with a matching manifest and no silent loss of task instructions.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/agent/context-compiler.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-035

### AG-041 — Lint workflow steps against effective tool and command permissions · P1

**Evidence class:** confirmed cross-layer inconsistency.

**Evidence and impact:** Plan/answer/edit prompts promise different workflows while tool policy, task authority and approval restrictions are separate. The 131 edit verification mismatch is a concrete example.

**Implementation:** Derive allowed workflow operations from the same capability record used to expose tools. Fail request compilation for required but impossible operations and identify the conflicting layer.

**Acceptance:** A no-tools answer never requires a source read; a restricted edit can verify through a permitted command; a disabled effect has a visible reason.

**Start in:** `electron/main/services/agent/loop.ts`; `electron/main/services/agent/prompts.ts`; `electron/main/services/agent/context-compiler.ts`; `src/shared/task-contract.ts`. **Dependencies:** AG-026, AG-037, AG-040

### AG-042 — Use task-relevant core tool sets without hiding essential operations · P2

**Evidence class:** measured optimization opportunity.

**Evidence and impact:** Plan tool definitions use 4,250 compact JSON characters; Composer uses 7,139. Every coding task currently sees image generation while some required execution tools are missing.

**Implementation:** Measure tool-selection precision and schema cost, then keep essential read/edit/verification operations accessible and defer unrelated domains. Maintain deterministic discovery and failure diagnostics.

**Acceptance:** A code-example task has no image overhead; a patch task has editing plus restricted verification; tool filtering never prevents completion merely to reduce schema size.

**Start in:** `electron/main/services/tool-registry.ts`; `electron/main/services/agent/loop.ts`. **Dependencies:** AG-035, AG-040, AG-041

## E. Scope, context and workspace grounding

### AG-043 — Treat filesystem resolution and semantic relevance as different states · P1

**Evidence class:** confirmed evidence limitation.

**Evidence and impact:** Every task reports scope=resolved and the same project ID, but metadata identifies a tiny divide(a,b) sample fixture for all 40 topics. Resolved does not mean relevant.

**Implementation:** Add scope applicability and evidence fields such as generic, selected-project, named-target and unverified relevance. Do not treat existence of the fixture root as proof that it contains the requested feature.

**Acceptance:** An abstract Java example does not claim the divide fixture implements it. A workspace edit still binds to the explicitly selected project.

**Start in:** `electron/main/services/task-intake.ts`; `src/shared/task-contract.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-004

### AG-044 — Evaluate each topic against a representative source fixture · P1

**Evidence class:** confirmed coverage gap.

**Evidence and impact:** The exported run has one sample fixture rather than authentication, search, jobs, front-end or multi-project implementations. It cannot test project-aware reasoning for those features.

**Implementation:** Associate curated cases with minimal but realistic projects and intended defects. Reuse eval materialization and disposable workspaces; keep abstract answer cases independent of repository fixtures.

**Acceptance:** A password-reset case has relevant source and tests, a React case has components, and a multi-project case contains an intentionally wrong sibling.

**Start in:** `electron/dev/main.ts`; `electron/main/services/eval-tasks.ts`; `electron/main/services/eval-runner.ts`. **Dependencies:** AG-043

### AG-045 — Add no-workspace and workspace-independent example scenarios · P1

**Evidence class:** coverage gap.

**Evidence and impact:** Every question receives the sample project root even when it requests generic design or language-specific code. All tasks therefore appear project-bound.

**Implementation:** Allow a genuine no-project case and distinguish generic examples from project-dependent changes. Keep project lookup optional when it cannot help answer the question.

**Acceptance:** The same generic TypeScript example can run with no workspace and with an unrelated project without changing its language, authority or relevance.

**Start in:** `electron/dev/capture.ts`; `electron/dev/main.ts`; `electron/main/services/task-intake.ts`. **Dependencies:** AG-004, AG-043

### AG-046 — Make snapshot omissions explicit and preserve selected configuration safely · P1

**Evidence class:** source-supported debugging parity gap.

**Evidence and impact:** snapshot skips every hidden entry, including .eris, .github and stack configuration directories. Real workspace rules and custom routing can be absent from a reproduction.

**Implementation:** Create an allowlisted diagnostic snapshot policy with an omission manifest and optional sanitized settings/rules. Exclude secrets by design and record skipped paths and reasons.

**Acceptance:** A workspace-specific routing/rule issue can be reproduced with selected nonsecret configuration, and the report declares every omitted category.

**Start in:** `electron/dev/main.ts`; `electron/dev/capture.ts`; `electron/main/services/debug-runs/redact.ts`. **Dependencies:** AG-043

### AG-047 — Export the context compiler manifest with every captured request · P1

**Evidence class:** confirmed export gap.

**Evidence and impact:** compileTaskContext records block inclusion/digests in the task ledger, but DevCapture exports only messages, schemas and basic model parameters. Truncation decisions are hidden from this review.

**Implementation:** Attach context blocks, source hashes/ranges, included/omitted reasons, input/output reservation and tool budget to the matching request. Include answer-only requests after unifying compilation.

**Acceptance:** A missing rule or source excerpt can be traced to absent input versus budget truncation without reverse engineering concatenated prompt text.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/task-ledger.ts`; `electron/dev/capture.ts`; `src/shared/eris-dev.ts`. **Dependencies:** AG-024

### AG-048 — Measure context using the active backend tokenizer where available · P1

**Evidence class:** source-supported performance and reliability gap.

**Evidence and impact:** Context budgeting uses character estimates, a 0.65 ratio and a further 0.55 system allocation. Captures use simulated:scripted rather than a provider tokenizer.

**Implementation:** Record tokenization method and reserve explicit output/tool budgets. Prefer the loaded adapter tokenizer and apply a conservative fallback with its uncertainty clearly labeled.

**Acceptance:** 4K/8K/16K cases verify actual serialized input limits where a tokenizer exists; no real-token accuracy claim is made for character estimates.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/context-budget.ts`; `electron/main/services/agent/compaction.ts`; `electron/main/services/model-transport.ts`. **Dependencies:** AG-047

### AG-049 — Stress context admission with realistic rules, source and history · P1

**Evidence class:** coverage gap.

**Evidence and impact:** The entire export uses context=8192 and empty history/skills. It does not exercise the mandatory-instruction error path or pressure from long code excerpts and tool results.

**Implementation:** Create boundary cases across supported windows, with large rules, attachments, source snippets and pending call/result pairs. Verify protected constraints survive trimming or produce an actionable error.

**Acceptance:** A long task never silently loses scope, edit restrictions or unresolved tool calls; oversized mandatory input gets a clear compiler failure.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/agent/compaction.ts`; `electron/main/services/debug-runs/coordinator.ts`. **Dependencies:** AG-047, AG-048

### AG-050 — Expose retrieval relevance and prevent irrelevant fixture grounding · P1

**Evidence class:** validation improvement.

**Evidence and impact:** Only 48 agent prompts contain the compiler retrieved-leads marker; most requests are generic and the one fixture does not implement their topics. Retrieval presence alone cannot prove useful evidence.

**Implementation:** Export retrieval query, ranked paths, scores, hashes and selected ranges. Add no-relevant-source and wrong-sibling tests; let generic code examples proceed without irrelevant reads.

**Acceptance:** An authentication question does not cite divide/index.js as authentication evidence. A real project question cites the relevant source or states missing evidence.

**Start in:** `electron/main/services/workspace-intelligence.ts`; `electron/main/services/agent/prompts.ts`; `electron/dev/capture.ts`. **Dependencies:** AG-043, AG-044, AG-047

### AG-051 — Check whether requested technology fits the selected project · P1

**Evidence class:** coverage/design requirement.

**Evidence and impact:** The corpus mixes React error boundaries with non-JavaScript languages and many frameworks. A generic fixture cannot establish compatibility or the intended analogy.

**Implementation:** Detect explicit stack requirements and observed project stack independently. For incompatible combinations, explain the adaptation or ask a focused choice; do not invent framework APIs in the requested language.

**Acceptance:** A request for error-boundary behavior in Rust receives an appropriate analogue with stated limits, rather than fabricated React lifecycle APIs.

**Start in:** `electron/main/services/task-resolver.ts`; `electron/main/services/task-intake.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-031, AG-044

## F. Conversation and agent-to-agent behavior

### AG-052 — Add true multi-turn chat evaluation sessions · P0

**Evidence class:** confirmed coverage gap for prior regression.

**Evidence and impact:** All 10,000 rows have threadId=null and only system/user model messages. The run never tests review → “implement those changes”, the recurring product failure described earlier.

**Implementation:** Import structured conversations with message IDs, history, selected project and expected transition. Feed them through shared production intake and preserve task revisions across turns.

**Acceptance:** A review gives recommendations without writes; “implement those” applies accepted items in the same project; “what changed?” summarizes actual diffs.

**Start in:** `electron/dev/main.ts`; `electron/dev/capture.ts`; `electron/main/services/chat-turn.ts`; `src/shared/debug-runs.ts`. **Dependencies:** None; can start independently.

### AG-053 — Carry recommendations as stable objects across follow-ups · P1

**Evidence class:** source-supported weakness and coverage gap.

**Evidence and impact:** No captured task contains recommendations. task-intake reconstructs them from numbered prose in the prior assistant answer, so format differences may lose what “those” means.

**Implementation:** Persist recommendation IDs, source message, target files and evidence when the review is produced. Resolve follow-up references against those objects, with a compatibility importer for old prose.

**Acceptance:** Bullet, paragraph and numbered review outputs support an implementation follow-up without asking the user to repeat the recommendations.

**Start in:** `electron/main/services/task-intake.ts`; `electron/main/services/task-store.ts`; `src/shared/task-contract.ts`. **Dependencies:** AG-052

### AG-054 — Identify the top-level worker separately from specialist children · P1

**Evidence class:** confirmed misleading role text.

**Evidence and impact:** Top-level Plan, Explainer, Fast and Verification prompts call themselves subagents despite receiving the actual user question directly. This is not proof of a bad answer, but blurs ownership.

**Implementation:** Add assignment kind and parent/coordinator identity. The top-level agent owns the response; a child owns a bounded result for its parent. Render role instructions accordingly.

**Acceptance:** A top-level explanatory answer is addressed to the user; a delegated exploration returns the requested evidence to its coordinator.

**Start in:** `electron/main/services/agent/prompts.ts`; `electron/main/services/chat-prompt.ts`; `src/shared/agent-orchestration.ts`. **Dependencies:** AG-012

### AG-055 — Capture child assignments and joins without broadening authority · P1

**Evidence class:** confirmed harness exclusion.

**Evidence and impact:** captureQuestion sets allowDelegate=false. No row can demonstrate that agents communicate, preserve scope, or wait for children.

**Implementation:** Add scripted child assignments/results using existing diagnostics scope and childTaskContract intersection. Export task IDs, project identity, budgets, effects and join state; keep production writes out of diagnostic fixtures.

**Acceptance:** A child cannot exceed parent authority or target another project, and queued work is never reported as completed.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/task-intake.ts`; `electron/main/services/agent/task-scheduler.ts`. **Dependencies:** AG-052, AG-054

### AG-056 — Evaluate disagreement, cancellation and partial child failure · P1

**Evidence class:** validation gap.

**Evidence and impact:** No model response or delegation cycle is present. Successful initial capture says nothing about integrating conflicting specialist advice.

**Implementation:** Script two children with conflicting findings, a failing child and a cancelled child. Require the coordinator to resolve evidence and report unfinished work before final synthesis.

**Acceptance:** A specialist assertion unsupported by source is not adopted as fact; cancellation propagates and the final state distinguishes partial results.

**Start in:** `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/debug-runs/oracle.ts`; `electron/main/services/agent/loop.ts`. **Dependencies:** AG-055

### AG-057 — Judge progress by satisfied obligations rather than tool activity · P1

**Evidence class:** validation gap tied to historical stuck loops.

**Evidence and impact:** The run stops before any tool cycle, so repeated calls, meaningless tree/read loops and unsupported “done” claims cannot be detected from its captured status.

**Implementation:** Extend replay scenarios with duplicate reads, failed writes and unchanged outputs. Link observed mutations/checks to task obligations and use bounded recovery when no new evidence is produced.

**Acceptance:** Repeated tree calls cannot satisfy an edit task. A real patch to the intended behavior advances progress; an unrelated file edit does not.

**Start in:** `electron/main/services/agent/workflow.ts`; `electron/main/services/agent/recovery.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-033, AG-060

### AG-058 — Keep task identity fixed during mid-run rerouting and recovery · P1

**Evidence class:** validation requirement for the existing architecture.

**Evidence and impact:** The export shows only initial agent selection; it cannot assess prior “mid-run re-route” and “no configured recovery agent” failures.

**Implementation:** Add replay cases that change workers/models after tool errors while retaining task ID, artifact, selected project, accepted recommendations and authority ceiling. Expose recovery reason and budget.

**Acceptance:** Recovery can replace Coder/Composer strategy but never turns a request for changes into a new read-only review or silently changes project.

**Start in:** `electron/main/services/agent/mid-run-adapt.ts`; `electron/main/services/agent/recovery.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-012, AG-057

## G. Real responses, simulation and debug modes

### AG-059 — Reuse the existing diagnostics engine for response evaluation · P1

**Evidence class:** confirmed harness limitation; existing implementation available.

**Evidence and impact:** Eris-Dev aborts before inference. debug-runs/coordinator already supports scripted, replay and real-model adapters through shared chat-turn helpers; a separate live implementation would risk divergence.

**Implementation:** Keep request capture as one mode and expose existing diagnostics execution modes with clear labels and explicit live-run configuration. Share stores, deadlines, redaction and oracles.

**Acceptance:** A selected curated case can run in capture, scripted, replay and live modes, all identifying their coverage. Live runs invoke the configured model and remain bounded.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/debug-runs/model-adapters.ts`; `src/eris-dev/main.tsx`. **Dependencies:** None; can start independently.

### AG-060 — Capture every request/reply/tool step through final outcome · P0

**Evidence class:** confirmed evidence gap.

**Evidence and impact:** All 10,000 details explicitly state that no agent response was generated. No final answer, tool result, diff or outcome verdict is available.

**Implementation:** In response-capable modes record request IDs, ordered reply chunks/final text, tool proposals/results, model changes, diffs and final outcome review. Keep no-response status explicit in capture mode.

**Acceptance:** A report can trace a final claim to the request, code change and check that support it. Capture-only cases remain ungraded for answer relevance.

**Start in:** `electron/dev/capture.ts`; `src/shared/eris-dev.ts`; `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/task-outcome.ts`. **Dependencies:** AG-059

### AG-061 — Add explicit model-response fields to the export schema · P1

**Evidence class:** confirmed export limitation.

**Evidence and impact:** DevCapture has request messages and tools only; DevResult.detail is the capture-stop message, not a model answer. An evaluator could misread messages as responses.

**Implementation:** Version the export with request, response, source mode, finish reason, usage and terminal outcome fields. Allow response=null with reason=not-generated. Provide a v1 reader.

**Acceptance:** Importing this v1 file yields response not observed; a new live file contains actual response text and its model identity. Metadata cannot imply otherwise.

**Start in:** `src/shared/eris-dev.ts`; `electron/dev/main.ts`; `electron/main/services/debug-runs/export.ts`. **Dependencies:** AG-060

### AG-062 — Display capture reachability separately from task success · P0

**Evidence class:** confirmed interpretation risk.

**Evidence and impact:** Every row says captured, but the same file contains contradictory plans and wrong capability routes. 100% captured means only that the model boundary was reached.

**Implementation:** Show independent statuses for import, intake, request validity, routing assessment, inference, execution, relevance and verification. Avoid green task-success badges for capture completion.

**Acceptance:** The current run reports 10,000 request captures, 0 generated answers and answer quality not evaluated. Wrong-route findings remain visible.

**Start in:** `src/eris-dev/main.tsx`; `src/shared/eris-dev.ts`; `electron/main/services/debug-runs/coordinator.ts`. **Dependencies:** AG-061

### AG-063 — Separate phase timings and live model performance metrics · P1

**Evidence class:** confirmed measurement limitation.

**Evidence and impact:** Capture durations range from 0 to 156 ms with a median of 1 ms. These are local scripted pre-inference measurements, not generation speed on the user GPU.

**Implementation:** Record import, routing, resolver, retrieval, prompt compile, queue, first token, generation, tools, outcome and persistence timings with units and clock source.

**Acceptance:** A capture chart is labeled pre-inference duration. Live reports show TTFT and generation throughput separately from routing overhead.

**Start in:** `electron/dev/capture.ts`; `electron/main/services/agent-telemetry.ts`; `electron/main/services/debug-runs/coordinator.ts`. **Dependencies:** AG-017, AG-060

### AG-064 — Pin export provenance and compatibility versions · P1

**Evidence class:** confirmed provenance gap.

**Evidence and impact:** The header has created/project/context/mode/total but lacks app build, Git SHA, prompt/routing versions, settings digest, question hash and fixture hash.

**Implementation:** Add immutable run metadata for these versions plus adapter capability, response source and schema version. Hash sensitive settings instead of exporting credentials; record dirty-source status.

**Acceptance:** Two runs can be compared only when their meaningful configuration differences are shown. The exact question/fixture content is reproducible.

**Start in:** `electron/dev/main.ts`; `electron/dev/capture.ts`; `electron/main/services/debug-runs/export.ts`. **Dependencies:** AG-061

### AG-065 — Give questions stable IDs and preserve original source positions · P1

**Evidence class:** confirmed export improvement.

**Evidence and impact:** Records use an array index only. Header removal or reordered/chunked imports can change that index and make cross-run comparisons fragile.

**Implementation:** Assign a content-derived stable question ID plus corpus ID, source line/record number and occurrence ID. Keep zero-based internal and one-based display indexing explicit.

**Acceptance:** A question can be found across chunked/reordered runs while duplicates remain separately addressable; Q2813 maps unambiguously to JSONL line 2814 in this export.

**Start in:** `src/shared/eris-dev.ts`; `electron/dev/questions.ts`; `electron/dev/main.ts`. **Dependencies:** AG-064

### AG-066 — Provide a corpus preparation/import preview · P1

**Evidence class:** observed user-facing import failure from the preceding turn.

**Evidence and impact:** The original TXT had three nonempty header lines plus 10,000 questions and exceeded the importer count. It had to be reformatted manually before this run.

**Implementation:** Add a preview with detected record count, headers/numbering and explicit normalization choices. Preserve raw input and report exactly what is excluded; support a manifest for multiline/metadata-rich cases.

**Acceptance:** The supplied numbered file can be previewed and normalized to exactly 10,000 questions without silently dropping real questions or rejecting harmless headings with a generic error.

**Start in:** `electron/dev/questions.ts`; `src/eris-dev/main.tsx`; `electron/dev/main.ts`. **Dependencies:** None; can start independently.

### AG-067 — Add independently reviewed expected outcomes to selected cases · P0

**Evidence class:** confirmed absence of quality labels.

**Evidence and impact:** The capture contains actual routes but no expected artifacts, scopes, effects or responses. The same classifier cannot define its own gold labels.

**Implementation:** Curate labels from the user request and fixture behavior independently of runtime routing. Permit multiple acceptable wording/routes when they deliver the same artifact and authority. Keep uncertain cases ungraded.

**Acceptance:** Q2, Q524 and the three data-model questions have human-reviewable expected artifacts; route metrics show labeled denominators and disagreements.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `electron/main/services/debug-runs/scenarios.ts`; `src/shared/debug-runs.ts`. **Dependencies:** AG-003, AG-065

### AG-068 — Gate releases on confirmed regressions rather than capture counts · P0

**Evidence class:** confirmed weakness in what this run proves.

**Evidence and impact:** 10,000 requests are captured successfully despite the answer-plan mismatch and capability collisions. Existing Eris-Dev tests check boundary reachability rather than these semantic invariants.

**Implementation:** Add deterministic gates for task/prompt/tool consistency and curated route regressions, then separate live quality qualification. Keep capture reachability as a distinct plumbing metric.

**Acceptance:** Builds fail if an answer requires edits or a domain data-model question is restricted to the Eris catalog. A no-model run never receives a live-quality pass.

**Start in:** `tests/eris-dev.test.ts`; `tests/chat-router.test.ts`; `tests/agent-prompts.test.ts`; `package.json`. **Dependencies:** AG-001, AG-006, AG-007, AG-023, AG-067

## H. Corpus coverage and answer assessment

### AG-069 — Store per-question expected behavior and evidence references · P1

**Evidence class:** confirmed missing review data.

**Evidence and impact:** This report can locate all 10,000 cases by index, but the original export has no reviewer notes or semantic pass/fail rationale.

**Implementation:** Persist expected artifact, allowed effects, fixture, topic, observed trace, reviewer verdict and evidence references in an evaluation manifest. Keep machine-generated candidates distinct from adjudicated labels.

**Acceptance:** Every evaluated case states why it passed/failed or why it is ungraded, with direct links to the matching request/response/diff.

**Start in:** `src/shared/debug-runs.ts`; `electron/main/services/debug-runs/oracle.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-065, AG-067

### AG-070 — Report coverage by topic, request form and execution stage · P1

**Evidence class:** confirmed coverage gap.

**Evidence and impact:** There are 40 topics but only one sample project and no response/tool cycles. Broad natural-language volume therefore hides narrow execution coverage.

**Implementation:** Track topic × artifact × language/framework × mode × fixture × stage coverage. Report uncovered cells and do not equate the Cartesian product with independent tasks.

**Acceptance:** A dashboard clearly shows that this run covers pre-inference routing only and that live completion, agent coordination and UI delivery are untested.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `src/shared/debug-runs.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-062, AG-069

### AG-071 — Grade code examples on completeness and correctness · P1

**Evidence class:** evaluation requirement; responses unobserved.

**Evidence and impact:** 789 Plan candidates and 477 Fast candidates show where requested code may be suppressed or underspecified. This export cannot establish whether any generated code is correct.

**Implementation:** Use the 40 topic rubrics in this document to define minimal compilable examples and behavior assertions. Check dependencies, language fidelity, failure paths and explanation of limitations.

**Acceptance:** A syntactically plausible snippet that omits requested restore behavior fails; a correct example with explicitly stated external setup is graded against that declared setup.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `electron/main/services/eval-runner.ts`; `electron/main/services/eval-tasks.ts`. **Dependencies:** AG-029, AG-033, AG-060

### AG-072 — Require observed patch and command evidence for implementation claims · P0

**Evidence class:** validation requirement for prior non-editing regression.

**Evidence and impact:** No captured row includes a mutation, command result or final claim. Prior product reports describe agents recommending changes instead of applying them.

**Implementation:** For patch tasks verify changed files, relevant behavior, authorized scope and actual check results. Require evidence receipts for claims; for examples explicitly state that code was provided in chat.

**Acceptance:** “Implemented” fails when only prose is returned. An unrelated README or metadata change cannot satisfy an application behavior request.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `electron/main/services/task-outcome.ts`; `electron/main/services/agent/workflow.ts`. **Dependencies:** AG-003, AG-033, AG-060

### AG-073 — Exercise tool/protocol failure recovery with meaningful scripts · P1

**Evidence class:** coverage gap.

**Evidence and impact:** No request in this run receives malformed calls, tool errors or retryable provider failures. Initial capture cannot validate repair behavior.

**Implementation:** Add deterministic cases for invalid arguments, missing files, stale baselines, duplicate calls, failed verification, cancellation and a lost stream after an accepted write. Assert bounded recovery and idempotence.

**Acceptance:** A replayed write is not applied twice, a failed check is not reported as passing, and unrecoverable cases have a precise terminal reason.

**Start in:** `electron/main/services/debug-runs/scenarios.ts`; `electron/main/services/model-protocol.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-060, AG-072

### AG-074 — Add full desktop chat submission and renderer delivery scenarios · P1

**Evidence class:** confirmed harness coverage boundary.

**Evidence and impact:** Eris-Dev directly calls shared services. This bypasses production streaming IPC and renderer chat state, so it cannot rule out the historical failure to process a submitted message.

**Implementation:** Use packaged-app scenarios that submit a chat through real IPC, stream events, reload/switch workspace and verify rendered terminal state. Reuse scripted transport for deterministic behavior.

**Acceptance:** A submitted turn renders once, shows the correct worker/task, preserves the user message and receives the expected final answer/diff across tested lifecycle events.

**Start in:** `electron/main/ipc/chat-stream.ts`; `src/hooks/useChatSession.ts`; `tests/chat-stream-diagnostics.test.ts`. **Dependencies:** AG-060, AG-062

### AG-075 — Redact exports with a deterministic evidence-preserving policy · P1

**Evidence class:** source-supported diagnostic sharing requirement.

**Evidence and impact:** The existing export contains raw prompt text, temporary absolute paths and potentially source snippets. A real project run could include confidential source or secrets.

**Implementation:** Reuse existing debug redaction and provide preview plus redaction manifest. Replace sensitive paths/values consistently so task linkage and the meaning of evidence survive.

**Acceptance:** A synthetic credential in a source excerpt is absent from a sanitized export, while question identity, relative file paths and causal trace remain usable.

**Start in:** `electron/main/services/debug-runs/redact.ts`; `electron/dev/main.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-061, AG-064

### AG-076 — Support chunking, resumable runs and explicit interrupted state · P1

**Evidence class:** source-supported scalability gap.

**Evidence and impact:** The app writes individual results and JSONL, but imported question state and the active run are process-local. A future long live run cannot be resumed from the UI.

**Implementation:** Persist a run manifest, stable question IDs, completed outcomes, active case and configuration hashes. Resume only compatible unfinished cases and mark interrupted writes/results explicitly.

**Acceptance:** An interrupted 10,000-question run resumes at the correct case without duplicating effects or silently changing model/settings.

**Start in:** `electron/dev/main.ts`; `electron/main/services/debug-runs/store.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-064, AG-065

### AG-077 — Compare reports by semantic task changes and evidence · P1

**Evidence class:** reporting improvement.

**Evidence and impact:** A raw 75 MB export is difficult to inspect, and task UUIDs/temp paths make naive text diffs noisy.

**Implementation:** Build run comparisons keyed by stable question ID, with normalized prompt blocks and changes to artifact, authority, agent, tools, response verdict and latency. Retain raw evidence for drill-down.

**Acceptance:** A routing fix shows Q2813 moving from capability to design/answer without counting UUID changes as regressions.

**Start in:** `src/eris-dev/main.tsx`; `electron/main/services/debug-runs/export.ts`; `electron/main/services/debug-runs/store.ts`. **Dependencies:** AG-014, AG-064, AG-065

### AG-078 — Promote high-value corpus failures into a compact regression suite · P1

**Evidence class:** measured prioritization opportunity.

**Evidence and impact:** Thousands of rows share a small number of prompt/route failure families. Running all 10,000 live for each edit would be slow and redundant.

**Implementation:** Select contrast pairs and representative failures across topic/template/stack while retaining the full corpus as a scheduled sweep. Include Q2, Q7, Q42, Q524, Q2813, Q8123 and Q8882.

**Acceptance:** The fast suite catches each known root cause; the full sweep reports remaining distribution changes with exact denominators.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `electron/main/services/debug-runs/scenarios.ts`; `tests/chat-router.test.ts`. **Dependencies:** AG-067, AG-068, AG-070

## I. Performance, model comparisons and diagnostic UX

### AG-079 — Compare agent architectures with the same real model and configuration · P1

**Evidence class:** essential validation requirement.

**Evidence and impact:** This export uses only simulated:scripted. It cannot support a conclusion that model selection is irrelevant to poor results or quantify an architectural fix.

**Implementation:** Run baseline/candidate architecture on the same independently labeled cases, model version, decoding settings, hardware and fixture. Repeat non-deterministic runs and report paired differences.

**Acceptance:** An improvement claim states both routing/artifact changes and observed completion outcomes; no gain is attributed solely from capture success.

**Start in:** `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/eval-store.ts`; `electron/main/services/debug-runs/model-adapters.ts`. **Dependencies:** AG-059, AG-064, AG-067

### AG-080 — Measure and stabilize reusable prompt prefixes · P2

**Evidence class:** measured prompt duplication opportunity.

**Evidence and impact:** Plan worker prompts have a median 4,559 system characters plus 4,250 tool-schema characters. Full task JSON with random IDs and roots precedes shared guidance; duplicate guidance adds avoidable work.

**Implementation:** Deduplicate first, then measure provider/session reuse. Keep stable general guidance and tools reusable without leaking task context; isolate volatile task data where the adapter permits cache-friendly ordering.

**Acceptance:** A benchmark reports actual prefill time/cache hits and correctness across task/project switches. Do not infer speed gains from character savings alone.

**Start in:** `electron/main/services/agent/context-compiler.ts`; `electron/main/services/chat-runtime.ts`; `electron/main/services/local-model.ts`. **Dependencies:** AG-025, AG-034, AG-063

### AG-081 — Use the existing resource admission queue for live corpora · P1

**Evidence class:** validation requirement for target hardware.

**Evidence and impact:** A no-inference 1 ms median provides no evidence about the 4060/5050 8 GB or Apple Metal generation behavior discussed earlier.

**Implementation:** Run live cases through normal inference admission, use bounded concurrency and retain memory/queue/cancellation telemetry. Coordinate image/text workloads rather than launching per-question model loads.

**Acceptance:** Live corpus execution stays within configured memory limits, reports queue wait and recovers from out-of-memory without losing all completed cases.

**Start in:** `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/inference-governor.ts`; `electron/main/services/local-model.ts`; `electron/main/services/gpu-accel.ts`. **Dependencies:** AG-059, AG-063, AG-076

### AG-082 — Add negative and boundary cases beyond the generated question corpus · P1

**Evidence class:** confirmed dataset boundary.

**Evidence and impact:** The 10,000 unique questions cover 40 repeated technical topics, but no thread references, malicious attachments, wrong-project alternatives, missing models or permission changes are represented.

**Implementation:** Maintain focused suites for ambiguous/missing project, no model, unavailable capabilities, unsupported language, hostile source, Ask restrictions, thread switching and cancel/retry edges.

**Acceptance:** Every important authority and lifecycle boundary has an independently defined expected result; corpus size is not used as a substitute for those cases.

**Start in:** `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/debug-runs/scenarios.ts`; `electron/main/services/debug-runs/oracle.ts`. **Dependencies:** AG-067, AG-070

### AG-083 — Use an outcome taxonomy that separates agent defects from environment limits · P1

**Evidence class:** confirmed review limitation.

**Evidence and impact:** Captured is the only success-like status in this file; future response tests can fail because of wrong intent, inadequate source, unsupported feature, model output, tool rejection or environment.

**Implementation:** Record failure stage and category with evidence: intake, scope, prompt, protocol, generation, tools, verification, synthesis, UI and environment. Preserve unresolved/unsupported instead of treating them as passes.

**Acceptance:** A missing dependency, bad route and incorrect generated algorithm are separately actionable. Aggregate pass rates retain skipped/ungraded denominators.

**Start in:** `electron/main/services/debug-runs/oracle.ts`; `src/shared/debug-runs.ts`; `src/eris-dev/main.tsx`. **Dependencies:** AG-062, AG-069

### AG-084 — Make the debug report navigable by failure family and question · P2

**Evidence class:** measured usability need.

**Evidence and impact:** The export is 74,825,686 bytes and the UI pages questions 100 at a time. Reviewing thousands of prompt duplicates manually makes causal patterns hard to see.

**Implementation:** Add search, severity/family/topic filters, grouped root causes, route comparison, one-click evidence and exportable reviewer notes. Keep full request bodies loaded on demand.

**Acceptance:** A reviewer can locate all three capability collisions, inspect Q524 and export selected evidence without paging through the whole run or loading every prompt into memory.

**Start in:** `src/eris-dev/main.tsx`; `electron/dev/main.ts`; `src/shared/eris-dev.ts`. **Dependencies:** AG-014, AG-065, AG-077

### AG-085 — Persist final artifacts and typed terminal states for every executed case · P1

**Evidence class:** validation gap.

**Evidence and impact:** This export proves initial boundary capture only. No applied patch, final answer, check artifact or post-run task state is available for later reviewers.

**Implementation:** In response-capable runs retain sandbox diff/answer/check receipts and terminal status with hashes and retention policy. Distinguish completed, partial, blocked, failed, cancelled and timed-out cases.

**Acceptance:** A later model can reproduce a finding from stored artifacts after the temp workspace is removed; incomplete work never appears as success.

**Start in:** `electron/main/services/debug-runs/coordinator.ts`; `electron/main/services/debug-runs/store.ts`; `electron/dev/main.ts`; `src/shared/debug-runs.ts`. **Dependencies:** AG-060, AG-061, AG-076, AG-083

## Topic-specific response and implementation rubrics

These 40 rubrics correspond to all topics recovered from the complete question corpus. Topic membership is based on exact longest phrase matching; every question matched one topic. For each topic, adapt the checks to the requested language/framework and artifact. Generic code examples can be evaluated in an isolated harness; workspace patches require matching source fixtures and observed diffs. Design answers should state assumptions and satisfy the relevant design checks without claiming execution. A snippet must not be graded as a full production system unless that was the requested artifact and the supporting integration exists.

Each rubric should add a positive case, boundary/failure case and explicit evidence requirement to the existing evaluation schema. Security-related statements here are engineering acceptance proposals, not a compliance certification. The original export supplies no generated answers to grade against these rubrics.

### TOPIC-01 — API key generation and rotation

**Corpus:** 240 questions; example Q48.

**Required behavior:** Cryptographically random keys; one-time display; stored hash; scopes/tenant binding; overlapping rotation; revoke/audit.

**Acceptance scenario:** Authenticate with old/new/revoked keys through the documented overlap, attempt cross-tenant use and prove logs/storage do not expose raw keys.

### TOPIC-02 — TOTP-based two-factor authentication

**Corpus:** 258 questions; example Q21.

**Required behavior:** Enrollment verification; protected secret storage; bounded skew; rate limiting; recovery codes; reset/recovery policy.

**Acceptance scenario:** Test time-window edges, reused steps under the stated policy, brute-force limits and recovery-code reuse; do not present QR generation as the entire 2FA system.

### TOPIC-03 — a circuit breaker around external API calls

**Corpus:** 260 questions; example Q33.

**Required behavior:** Closed/open/half-open transitions; concurrent probe limits; timeout integration; error classification; recovery/backoff.

**Acceptance scenario:** Trip the threshold, allow only bounded half-open probes under concurrency and test recovery; ordinary retries alone do not implement a circuit breaker.

### TOPIC-04 — a multi-step form that saves progress

**Corpus:** 240 questions; example Q36.

**Required behavior:** Per-step schema; versioned draft; autosave ordering/debounce; navigation/restore; conflict handling; privacy and submission.

**Acceptance scenario:** Reload mid-form, deliver save replies out of order and migrate a prior draft; invalid partial drafts must not be treated as a completed final submission.

### TOPIC-05 — a secure password reset flow

**Corpus:** 258 questions; example Q18.

**Required behavior:** One-use expiring token digest; anti-enumeration; password policy; atomic redemption; session invalidation and rate limits.

**Acceptance scenario:** Attempt reuse, expiry, guessing and parallel redemption; verify stored secrets are not raw reset tokens and unrelated user sessions follow the stated policy.

### TOPIC-06 — audit logging for sensitive operations

**Corpus:** 238 questions; example Q140.

**Required behavior:** Actor/action/target/time/outcome; redaction; durable append policy; transaction/outbox relation; access controls and tamper evidence.

**Acceptance scenario:** Fail the sensitive operation and audit sink in separate cases, verify declared loss/blocking behavior and exclude credentials; ordinary debug logs alone are insufficient.

### TOPIC-07 — background job processing with exponential backoff

**Corpus:** 259 questions; example Q24.

**Required behavior:** Durable state; idempotent handlers; exponential delay with jitter/cap; retry classification; dead-letter policy; cancellation.

**Acceptance scenario:** Crash after an external effect, redeliver the job, exceed retries and verify no duplicate outcome under the documented idempotency contract.

### TOPIC-08 — bulk operations that report progress

**Corpus:** 235 questions; example Q29.

**Required behavior:** Durable job identity; defined numerator/denominator; per-item failure accounting; idempotence; cancellation and reconnect.

**Acceptance scenario:** Fail selected items, restart a worker and reconnect the progress client; report completed/failed/skipped totals without presenting partial work as complete.

### TOPIC-09 — cache invalidation after data changes

**Corpus:** 252 questions; example Q20.

**Required behavior:** Key scope/versioning; successful-commit ordering; TTL; concurrent updates; distributed invalidation; cache-stampede handling.

**Acceptance scenario:** Race a read with a commit and failed transaction, simulate stale nodes, and document consistency guarantees rather than claiming instantaneous consistency without a mechanism.

### TOPIC-10 — cursor-based pagination for a large dataset

**Corpus:** 251 questions; example Q100.

**Required behavior:** Indexed stable ordering; unique tie-breaker; opaque/validated cursor; filter binding; next-page query and limits.

**Acceptance scenario:** Page across equal sort values and concurrent inserts/deletes, reject malformed or mismatched-filter cursors and inspect realistic query plans.

### TOPIC-11 — database connection pooling

**Corpus:** 266 questions; example Q1.

**Required behavior:** Pool ownership and configuration; bounded size; acquire/release lifetime; timeout/backpressure; shutdown and transaction boundaries.

**Acceptance scenario:** Exhaust the pool, force an exception in a transaction and confirm connections return; verify concurrent queries do not exceed the configured maximum.

### TOPIC-12 — distributed tracing across services

**Corpus:** 251 questions; example Q77.

**Required behavior:** Trace context propagation; spans and error status; sampling; async boundaries; baggage/redaction; exporter failure isolation.

**Acceptance scenario:** Propagate through HTTP plus a queued job, verify parent relationships and ensure exporter failure does not fail the business request.

### TOPIC-13 — environment-specific configuration loading

**Corpus:** 228 questions; example Q12.

**Required behavior:** Typed schema validation; precedence; required values; separation of secrets/client-safe values; startup failure diagnostics.

**Acceptance scenario:** Test missing and invalid config, source precedence and an attempted secret inclusion in client output; avoid silent production defaults for required secrets.

### TOPIC-14 — error boundaries that support retry

**Corpus:** 254 questions; example Q10.

**Required behavior:** Correct framework scope; fallback UI; reset/error state; async/event-handler limitations; cleanup and bounded retry.

**Acceptance scenario:** Throw during supported rendering, reset after changing inputs, and explain how async failures are handled separately; non-React languages need an explicit analogue.

### TOPIC-15 — exporting filtered data to CSV

**Corpus:** 237 questions; example Q47.

**Required behavior:** Reuse validated filter semantics; streaming; correct quoting/newlines/encoding; formula-injection handling; authorization and cancellation.

**Acceptance scenario:** Export quoted/multiline cells, a formula-like value and a large filtered dataset; confirm output matches permitted rows and memory does not scale with the entire export.

### TOPIC-16 — feature flags that can be toggled without redeploying

**Corpus:** 261 questions; example Q26.

**Required behavior:** Typed flag keys; safe defaults; targeting/tenant scope; cache refresh; provider outage; deterministic assignment and audit.

**Acceptance scenario:** Toggle while requests are active, test stale/outage behavior and stable rollout assignment; distinguish a hot configuration service from compile-time environment variables.

### TOPIC-17 — file uploads with progress tracking and cancellation

**Corpus:** 249 questions; example Q30.

**Required behavior:** Server validation; streaming/size limits; cancellation propagation; temporary-file cleanup; progress units; retry policy.

**Acceptance scenario:** Cancel mid-transfer and force a network error, verify cleanup and no partial published artifact; browser upload progress is not server-side processing completion.

### TOPIC-18 — forcing logout across all devices

**Corpus:** 243 questions; example Q13.

**Required behavior:** Session registry or revocation version; refresh-token invalidation; access-token validity window; enforcement and UX.

**Acceptance scenario:** Use sessions on two devices, revoke globally and verify both fail according to the stated propagation/expiry guarantees; client-only storage clearing is insufficient.

### TOPIC-19 — generating image thumbnails on the fly

**Corpus:** 253 questions; example Q7.

**Required behavior:** Input byte and pixel limits; safe decode; EXIF orientation; aspect ratio; bounded worker resources; cache keys.

**Acceptance scenario:** Use malformed files, large pixel dimensions, rotated images and repeated requests; prove resource limits and output dimensions. Do not invoke AI image generation for ordinary thumbnail resizing.

### TOPIC-20 — graceful shutdown of a long-running process

**Corpus:** 241 questions; example Q38.

**Required behavior:** Stop accepting work; cancel/drain inflight tasks; close resources in order; bounded deadline; repeated signals.

**Acceptance scenario:** Send a shutdown signal during active work, verify deadline escalation and no resource leak, and explain platform-specific signal behavior for the selected runtime.

### TOPIC-21 — health checks that verify downstream dependencies

**Corpus:** 236 questions; example Q44.

**Required behavior:** Separate liveness/readiness; dependency-specific timeout; bounded concurrency; failure aggregation; cached or lightweight probes.

**Acceptance scenario:** Make one dependency slow and another unavailable; verify timeout and readiness response without creating cascading load. This is a feature to implement/explain, not inherently a task to test existing code.

### TOPIC-22 — idempotent API endpoints

**Corpus:** 243 questions; example Q84.

**Required behavior:** Key namespace; request hash; concurrent atomic ownership; response replay; expiry; transaction boundary and conflict handling.

**Acceptance scenario:** Send simultaneous identical requests and reuse the key with a different payload; verify one effect and a clear conflict response under the chosen semantics.

### TOPIC-23 — infinite scroll using cursor pagination

**Corpus:** 250 questions; example Q56.

**Required behavior:** Stable cursor ordering; duplicate prevention; stale request cancellation; termination; retry and accessible loading/navigation.

**Acceptance scenario:** Insert/delete items between pages and return requests out of order; confirm no duplicate appends and no endless loading when nextCursor is absent.

### TOPIC-24 — optimistic updates for a list of items

**Corpus:** 268 questions; example Q11.

**Required behavior:** Temporary identity; rollback; pending UI; out-of-order acknowledgements; duplicate requests; reconciliation with server truth.

**Acceptance scenario:** Reject a mutation after a later update succeeds, reorder replies and reconcile IDs; a naive snapshot rollback must not erase unrelated newer work.

### TOPIC-25 — per-user rate limiting

**Corpus:** 246 questions; example Q6.

**Required behavior:** Stable user/tenant key; atomic counter/token bucket; expiry; retry signaling; distributed clock/storage failures.

**Acceptance scenario:** Make concurrent requests around a boundary, verify independent users/tenants, and test the documented fail-open/fail-closed behavior when the store is unavailable.

### TOPIC-26 — real-time presence indicators

**Corpus:** 238 questions; example Q49.

**Required behavior:** Session/device identity; heartbeat/TTL; reconnect; multiple devices; stale/offline transitions; fanout limits.

**Acceptance scenario:** Disconnect without clean logout, reconnect and close one of two devices; presence must expire correctly without marking the user offline while another valid session remains.

### TOPIC-27 — request validation middleware

**Corpus:** 258 questions; example Q107.

**Required behavior:** Transport parsing; schema; explicit coercion policy; size limits; unknown-field policy; structured errors; no handler execution on failure.

**Acceptance scenario:** Submit wrong types, oversized and extra fields and assert stable error responses; distinguish syntactic validation from authorization/business rules.

### TOPIC-28 — role-based access control

**Corpus:** 248 questions; example Q8.

**Required behavior:** Server-side policy evaluation; deny by default; object and tenant scope; role mapping; separate authentication/authorization.

**Acceptance scenario:** Test direct endpoint access as anonymous, permitted, wrong-role and wrong-tenant users; hiding a button alone does not satisfy authorization.

### TOPIC-29 — rotating secrets without downtime

**Corpus:** 246 questions; example Q5.

**Required behavior:** Versioned secret retrieval; overlap period; atomic switch; cache invalidation; rollback and redacted logging.

**Acceptance scenario:** Serve concurrent requests during rotation, reject a retired secret after the overlap, and prove neither logs nor exported examples expose real credentials.

### TOPIC-30 — sanitizing user-generated rich text

**Corpus:** 254 questions; example Q51.

**Required behavior:** Explicit allowed HTML/attributes/URLs; maintained sanitizer; server-side enforcement; output context and preview consistency.

**Acceptance scenario:** Try scripts, event handlers, dangerous URLs and malformed nested markup; regex tag removal alone must not pass the safety rubric.

### TOPIC-31 — scheduled report generation

**Corpus:** 258 questions; example Q9.

**Required behavior:** Durable schedule/timezone handling; idempotent jobs; authorization/data scope; overlap policy; resumable storage and delivery.

**Acceptance scenario:** Trigger duplicate and missed schedules, test timezone boundaries and worker restart, and verify duplicate reports are handled by a documented policy.

### TOPIC-32 — search that supports filters, sorting, and highlighting

**Corpus:** 272 questions; example Q27.

**Required behavior:** Validated query/filter model; stable sort/tie-break; pagination consistency; indexed query plan; escaped/sanitized highlighting.

**Acceptance scenario:** Combine filters, equal sort values and malicious highlight text, then inspect query behavior on realistic volume without asserting speed from a toy collection.

### TOPIC-33 — seeding realistic test data

**Corpus:** 253 questions; example Q35.

**Required behavior:** Deterministic seed; schema-valid relational fixtures; bounded size; cleanup; environment guard; synthetic non-sensitive data.

**Acceptance scenario:** Run twice with the same seed, validate relationships and forbid accidental production seeding; this request must not be confused with verifying an existing implementation.

### TOPIC-34 — soft deletes with the ability to restore

**Corpus:** 259 questions; example Q2.

**Required behavior:** Deletion marker and default query filtering; restore semantics; uniqueness collisions; authorization and related records.

**Acceptance scenario:** Delete then fetch through ordinary queries, restore, and test restoring into a conflicting unique key. Demonstrate which administrative queries include deleted rows.

### TOPIC-35 — structured JSON logging

**Corpus:** 251 questions; example Q19.

**Required behavior:** Stable schema/levels; contextual IDs; safe serialization; redaction; error stack handling; bounded payloads and sink failure.

**Acceptance scenario:** Log a circular or malformed value and a synthetic secret, parse every record as JSON and verify trace/request correlation without leaking sensitive fields.

### TOPIC-36 — transactional emails using templates

**Corpus:** 237 questions; example Q41.

**Required behavior:** Escaped templates; provider adapter; outbox/durable enqueue; idempotency; transient retry; secrets/config and delivery observability.

**Acceptance scenario:** Render hostile template input, redeliver an outbox entry and simulate provider failure; queued/accepted mail must not be called delivered without supporting evidence.

### TOPIC-37 — user authentication with magic links

**Corpus:** 249 questions; example Q3.

**Required behavior:** One-use, expiring random tokens; stored token digest; safe redirect allowlist; anti-enumeration response; session creation.

**Acceptance scenario:** Exercise expired and reused links, invalid destinations and concurrent redemption; state delivery/session integration rather than claiming a complete deployment from a snippet.

### TOPIC-38 — user notification preferences

**Corpus:** 259 questions; example Q16.

**Required behavior:** Preference model/defaults; channel/topic scope; authorization; consent changes; delivery-time evaluation and cache invalidation.

**Acceptance scenario:** Opt out while a message is queued, test channel-specific overrides and wrong-user updates, and state any legally required notification exceptions as product decisions.

### TOPIC-39 — webhook signature verification

**Corpus:** 246 questions; example Q17.

**Required behavior:** Raw request bytes; correct signature/timestamp parsing; constant-time digest comparison; replay window; key rotation; size limits.

**Acceptance scenario:** Alter one byte, reorder/normalize body input, use stale timestamps and concurrent replay, and verify the intended raw-body integration in the chosen framework.

### TOPIC-40 — zero-downtime database migrations

**Corpus:** 255 questions; example Q4.

**Required behavior:** Expand/backfill/contract sequencing; old/new application compatibility; bounded lock time; backfill restart; rollback constraints.

**Acceptance scenario:** Run old and new code against intermediate schema states; interrupt/restart the backfill and document which steps are reversible.

## Validation and release evidence to collect after fixes

1. Run the request audit again on a newly generated export; the original capture remains historical evidence. Candidate routes may change legitimately, so compare requested artifacts and effect authority rather than agent-name equality alone.
2. Assert zero contradictory answer/edit plans, zero application-data-model capability collisions in labeled cases, no disabled image schema in matching captures, and feasible verification for patch tasks.
3. Use independently labeled examples and contrast pairs for the 789 code-artifact candidates, 94 verification candidates and 477 Fast/depth candidates. Report adjudicated counts separately from detector counts.
4. Execute curated scripted and replay scenarios through the shared production turn pipeline, including follow-up edits and child joins. Record exact coverage exclusions.
5. Execute an explicitly configured representative real-model suite with the same model/settings/fixtures for baseline and candidate; retain replies, diffs, command evidence, failure stages and timing. Report unknown/skipped cases.
6. Check packaged desktop submission/rendering and the target hardware separately. Passing service tests does not establish UI delivery or GPU stability.

Proposed release criteria are zero unauthorized/wrong-project mutations, zero unsupported completion claims in the mandatory suite, no known question/contract/tool contradictions, and typed terminal outcomes for every executed case. Live quality/latency thresholds should be set after collecting an actual baseline; this request-only export cannot justify an invented target.

## Files accompanying this review

- `AGENT-IMPROVEMENTS.md`: this detailed implementation backlog and topic rubrics.
- `improvements.json`: the same recommendations and rubrics in structured form for other models.
- `metrics.json`: exact aggregate counts, source hashes and request-size/capture-time statistics.
- `question-audit.csv`: all 10,000 question assessments with source line, route, flags and expected-behavior guidance; suitable for spreadsheet filtering.
- `question-audit.jsonl`: the same audit plus authority/tool details; answer_quality is explicitly not_observed.
- `routing-regression-candidates.json`: machine-selected cases for independent review, not executable gold labels.
- `analyze_capture.py`: reproducible standard-library analyzer. It reads imports only as JSON/text data and does not call models or execute imported content.

Reproduce the corpus scan:

```sh
python3 docs/reviews/eris-dev-10000-2026-10-23/analyze_capture.py \
  /Users/ericembling/Desktop/eris-dev-requests.jsonl \
  /Users/ericembling/Desktop/10000_natural_diverse_coding_questions.txt
```

The scan does not regenerate curated backlog text or gold labels. Keep review notes and future adjudications versioned. No network calls or live model inference were used in this review.
