# Eris: follow-up review of the 10,000-question agent fixes

Review date: 2026-10-23. Deliverable: an implementation backlog for subsequent engineers and models, based on the current code rather than the historical capture alone.

## 1. Scope, provenance, and evidence limits

The reviewed checkout is `agent-improvements-stage6` at `92f3e68`. GitHub refs were fetched during this review. The latest `origin/main`, `3c6cfea`, merges that branch through PR #50; `git diff HEAD origin/main` is empty. Therefore this review covers the latest main source tree without changing branches or overwriting local work. Package version is 0.4.13.

The original evidence review is `docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md`, with 85 recommendations and 40 topic rubrics. Relevant implementation commits include `0683e53` (routing and contract fixes), `072c1f1` (artifact/effect separation), `0a11d62` (prompt and capability consolidation), `32f5bd2` (request versus answer evidence), `8d27399` (continuations and delegation state), `53687d2` (qualification, grading, persistence and comparison), and `92f3e68` (build gates). Subsequent security/portability fixes are also present. These are the changes the user described as Claude's work; commit authorship alone does not establish which model wrote each line.

This is a review, not an implementation of the backlog. No production code was modified. No paid provider or downloaded model was invoked. No application rebuild or release was performed. The historical export remains evidence of prepared requests, not generated answers.

Validation performed:

- Ran `tests/agent-regression-suite.test.ts`, `tests/agent-qualification.test.ts`, `tests/eris-dev.test.ts`, and `tests/agent-conversation.test.ts`: **4 files, 91 tests passed**.
- Ran a separate review probe against actual functions, preserving its source and JSON results beside this document. Its passing test status means the observations were recorded, not that the behavior is correct.
- Compared the fallback suite's routing calculation against production bypass precedence over all **10,000 questions**: **134 differences**. This is a test-path discrepancy count, not an independently labeled count of wrong agent decisions.
- Ran Q107 and Q413 through `captureQuestion`, the production request preparation boundary: both were `edit` / `patch`, with edit authority, and **zero invariant findings**. These are stronger counterexamples than helper-only inspection, but still contain no model answer or executed mutation.
- Examined current capture/import/resume/export/UI code, task interpretation, intent resolution, conversation handling, prompt compilation, recommendation extraction, grading, diagnostic orchestration, and build gates.

Evidence labels used below:

- **Reproduced:** a focused executable probe demonstrates the stated behavior.
- **Source-confirmed:** the relevant control flow or omission is visible in current code; a desktop interaction or failure injection is still needed to validate its user-facing manifestation.
- **Coverage/design gap:** proposed capability or qualification work, not a claim that an unobserved run failed.

P0 means address before treating qualification as a release-quality guarantee. P1 means significant product correctness or reliability work. P2 means important diagnostic usability, coverage, or maintainability. Priorities refer to this review's proposed order, not CVSS severity or a claim that every item blocks every release.

## 2. What improved and should be preserved

The original answer-versus-edit contradiction received real architectural work. Requested artifacts, destinations, effect authority, obligations and routing traces now have explicit representations. Answer prompts include a task contract and avoid automatically demanding workspace edits. Known data-model and test-feature collisions have focused contrast tests. These are valuable changes; another rewrite should preserve their invariants.

Prompt compilation records context provenance and estimated budgets, and distinguishes task authority from source evidence. Capability-derived tool exposure and workflow linting reduce impossible plans. They still need end-to-end consistency tests, but should remain shared production components rather than being reimplemented in a separate evaluator.

Eris-Dev now clearly labels request reachability, request validity, absent inference and unevaluated answer quality. Imports expose exclusions, exports carry provenance, and captures persist to disk. The diagnostic coordinator also supports scripted and live responses and multi-turn scenarios. Those systems serve different evidence levels and should remain clearly identified in the UI.

Stage 6 adds useful qualification primitives: topic rubrics, unsupported-claim checks, typed outcomes, coverage reports, run resume, sanitized export and capture comparisons. The main risk is that these new primitives can produce false confidence. Several new tests verify that a field exists or that a helper returns a plausible result without challenging the meaning of that result.

The Stage 6 build gate now includes qualification and corpus suites. That is a worthwhile release improvement. A green build presently means those scripted assertions passed; it does not establish model answer correctness, successful tool execution across the corpus, specialist collaboration, or desktop chat delivery.

## 3. Highest-priority findings

The most urgent implementation sequence is:

1. Correct the regression suite to execute production resolver precedence, then repair the demonstrated unwanted patch routes.
2. Separate edit and execution prohibitions; preserve quoted command operands and language identifiers without promoting quoted instructions.
3. Preserve ordinary JSON and named objects in visible answers.
4. Make qualification verdicts reflect semantic evidence, especially mixed verification results and keyword-only examples.
5. Repair comparison identity and resume integrity before relying on exported trend reports.
6. Add bounded executable fixtures and desktop delivery tests, followed by separately authorized live-model qualification.

The rest of this document provides independently assignable work items with implementation boundaries and acceptance behavior. New IDs use `FR-` to avoid confusing them with the original `AG-` backlog.

## 4. Chat interpretation and production routing

### FR-001 — The full-corpus regression sweep bypasses production precedence

**Priority/evidence:** P0, reproduced. **Classification:** newly added test blind spot. **Targets:** `tests/agent-regression-suite.test.ts::fallbackRoute`; `electron/main/services/task-resolver.ts::resolveTaskDecision`.

The suite always calls `conservativeFallback(text, classifyIntent(...))`. Production first applies `resolverBypassRule` and returns the initial intent for matching rules. Across 10,000 questions, 134 bypassed cases would be reported differently by the suite. Its assertion that no corpus question receives edit/run effects therefore does not establish that property in production. Q107 is reported as plan by the helper while the actual capture prepares an editable patch.

**Implementation:** replace the reconstructed pipeline with the production resolver under a deterministic transport adapter. Report bypass, semantic and fallback populations separately. Keep helper tests as unit tests, but do not use their outputs as production routing metrics.

**Acceptance:** every corpus case records the actual resolution source. Q107 and Q413 reproduce current production behavior before a routing fix, then fail until the behavior is corrected. Preserve the 10,000 denominator and publish discrepancies rather than hiding them behind an all-green aggregate.

### FR-002 — “How would you write it?” still acquires patch authority

**Priority/evidence:** P0, reproduced at the production capture boundary. **Classification:** residual original defect. **Targets:** `src/shared/agent-contract.ts::asksToImplementChanges`; `electron/main/services/chat-router.ts`; `electron/main/services/task-resolver.ts`.

Q107 asks, “I want request validation middleware to be easy to reason about. How would you write it?” Current capture selects edit/patch with `authority.edit=true`. Q413, “Write me a clear implementation of seeding realistic test data in Java?”, also becomes a patch in a JavaScript sample workspace. Neither capture receives invariant findings. The exact desired destination for all 134 discrepant cases needs labeling; these examples demonstrate why conservative artifact handling cannot exist only in the test helper.

**Implementation:** resolve requested destination before an implementation bypass grants edit authority. Distinguish a complete example in chat from a request to apply it to the selected repository. Do not simply downgrade all coding requests: explicit “add this to src/api.ts” must still edit.

**Acceptance:** add production-boundary contrast cases for examples, questions about approaches, named-file changes and new applications. Confirm artifact, destination, authority, worker and compiled prompt agree.

### FR-003 — “Do not run tests” incorrectly prohibits code edits

**Priority/evidence:** P1, reproduced. **Classification:** regression in the artifact/constraint changes. **Targets:** `src/shared/task-interpretation.ts::forbidsMutation`; `electron/main/services/task-intake.ts`; `chat-router.ts::classifyIntentTraced`.

“Fix the bug but do not run tests” resolves to explore with mutation forbidden. `forbidsMutation` treats run/execute prohibitions as edit prohibitions, and intake changes the entire tool policy to read. The response contract also expands the constraint to “Do not change files or run anything.” The user permitted a patch and restricted only execution.

**Implementation:** represent forbidden effects independently: editing, verification execution, arbitrary execution, commits and external actions. Derive capability filters from that record. Use a constraint trace so the UI can explain which phrase denied which effect.

**Acceptance:** “edit but don't run” permits a patch and prohibits execution; “run tests without changing files” permits approved verification and prohibits edits; “don't commit” does not prohibit a local patch. Preserve the existing full read-only behavior for “do not change anything.”

### FR-004 — Removing inline code erases legitimate command and language operands

**Priority/evidence:** P1, reproduced. **Classification:** introduced interpretation limitation. **Targets:** `src/shared/task-interpretation.ts::requestTextForIntent`, `requestedLanguage`; router and resolver callers.

`Run \`npm test\`` becomes an answer because the command operand is deleted before classification. `Use \`TypeScript\` for this example` loses its language. Treating quoted material as non-authoritative is correct, but deleting all quoted operands prevents the surrounding user instruction from referring to them.

**Implementation:** parse spans into instruction and quoted-data segments. Use the unquoted action to determine intent and allow it to bind a quoted argument as data. Never scan a pasted command independently as permission to execute it.

**Acceptance:** quoted filenames, shell commands, language names, JSON payloads and error messages remain usable operands. “Explain \`npm test\`” stays explanatory; “Run \`npm test\`” becomes execution subject to normal command approval.

### FR-005 — Empty sanitized text falls back to the original quoted instructions

**Priority/evidence:** P1, reproduced at classification; downstream mutation not demonstrated. **Targets:** `chat-router.ts::classifyIntentRule`; `task-resolver.ts::resolverBypassRule`; `task-interpretation.ts::requestedArtifact`.

A message consisting only of a fenced “Delete all files” is classified as edit because several callers use `requestTextForIntent(text) || text`. This restores the very material the parser removed. The focused example subsequently lacks a bypass and would take conservative fallback without confident semantic resolution, so this review does not claim deletion occurs. The inconsistent trust boundary still matters.

**Implementation:** return an explicit “no instruction outside quoted content” result. Handle it through an explanatory/clarification path, never by restoring untrusted text as the instruction source.

**Acceptance:** quote-only and fence-only inputs cannot gain effects from their contents. Explicit surrounding instructions such as “explain this” or “apply this patch” remain meaningful with the quoted content supplied as data.

### FR-006 — Language selection conflates source language and requested target

**Priority/evidence:** P2, source-confirmed design limitation. **Targets:** `src/shared/task-interpretation.ts::requestedLanguage`, `artifactResponseContract`.

Language extraction selects the earliest named language, including a framework-implied language. Requests such as “Convert this Python example to TypeScript” need two roles, not the first language mentioned. The current contract's single language field can then instruct the worker to use the wrong stack. This is outside the narrowly templated corpus families even though it is a common IDE task.

**Implementation:** model source language, target language and requested frameworks separately. Prefer explicit conversion target syntax; use project detection only where the user has not specified a target. Keep ambiguity visible instead of silently choosing the first match.

**Acceptance:** cover Python-to-TypeScript, JavaScript-to-TypeScript, a Django backend plus React frontend, and quoted target names. Check the compiled model instruction, not only extraction results.

### FR-007 — Follow-up implementation obligations silently stop at ten recommendations

**Priority/evidence:** P1, source-confirmed. **Targets:** `electron/main/services/task-intake.ts` recommendation obligations; `src/shared/recommendations.ts::extractRecommendations`.

Recommendation extraction retains at most 30 items, but patch obligations use only `recommendations.slice(0,10)` and truncate each text to 240 characters. A user asking to implement a long review can receive a contract whose explicit acceptance obligations omit most work. The full recommendation objects remain available elsewhere, so this is a completeness/accounting defect rather than proof all later items are always ignored.

**Implementation:** retain the full selected recommendation set durably. Batch execution as needed, but never make a batch limit an implicit scope limit. Give each recommendation a state and dependency list, and retain its complete acceptance requirements outside the prompt budget.

**Acceptance:** a 40-item review followed by “implement all” accounts for all 40 as completed, deferred with a reason, blocked, or pending. No invisible truncation; completion requires accounting for the full authorized set.

### FR-008 — Follow-ups cannot reliably select a subset of prior recommendations

**Priority/evidence:** P1, source-confirmed limitation. **Targets:** `task-intake.ts::refersToPrior` and recommendation selection.

When a reference phrase matches, intake takes the entire prior offered list; it does not resolve “only items 2 and 4,” “all except caching,” or “the first one.” Numeric selection and exclusion need explicit representation before edits start. Otherwise a broad “those” detector can attach more work than the current user selected, while other references can fail to attach any.

**Implementation:** resolve references to stable recommendation IDs, including positive selections and exclusions. If a material selection cannot be resolved, request a narrow clarification. Carry selected IDs into obligations, child assignments and completion evidence.

**Acceptance:** verify numbered, named and exclusion-based selections through a multi-turn production scenario, with diff assertions proving unselected changes were not applied.

### FR-009 — Recommendation extraction treats ordinary lists as implementation advice

**Priority/evidence:** P2, source-confirmed. **Targets:** `src/shared/recommendations.ts::itemsFrom`, `extractRecommendations`.

Any bullet/numbered list wins over paragraph advice and is accepted without the `ADVICE` predicate used for paragraphs. Dependency lists, observed failures, examples and quoted lists can become offered recommendations. IDs also incorporate a hash of the entire answer, so unrelated wording changes rename every recommendation.

**Implementation:** store structured recommendations from the review workflow, with a conservative legacy prose importer. Distinguish findings, alternatives, steps and recommendations. Assign IDs from normalized recommendation identity and source location rather than the complete answer text.

**Acceptance:** mixed answers containing dependencies, findings and actual recommendations yield only actionable offers. Reformatting the introduction preserves recommendation identity; repeated distinct recommendations remain distinguishable.

## 5. Visible answers and qualification accuracy

### FR-010 — Legitimate JSON examples are removed from final answers

**Priority/evidence:** P0, reproduced. **Classification:** incomplete Stage 6 repair of an existing parser problem. **Targets:** `electron/main/services/agent/tool-parsing.ts::isToolEnvelopeBody`, `stripToolBlocks`, `proseOutsideTools`.

A package.json example with `{"name":"demo","scripts":{"test":"vitest"}}` is removed, leaving only “Here is package.json:”. A prose object `{"name":"Alice","age":30}` is also removed. The Stage 6 fence fix identifies any parsed object with a string `name` as a tool envelope; the older prose cleanup is similarly broad. This can make a good model response appear empty or incomplete.

**Implementation:** classify protocol using explicit envelope/native-call metadata and actual emitted call spans. A common domain property such as `name` is insufficient. Keep ordinary fenced examples intact even when they describe a known tool as data.

**Acceptance:** package manifests, user records, nested named objects, TypeScript objects, and documentation of tool APIs survive rendering. Actual executed tool envelopes are hidden. Test the complete posted-answer path, not only the parser helper.

### FR-011 — Comment-only code passes implementation grading

**Priority/evidence:** P1, reproduced. **Targets:** `src/shared/code-grading.ts`; topic rubrics; diagnostic oracle.

The TypeScript block `// deletedAt filter restore` passes the soft-delete rubric, with every core behavior marked covered. The implementation accurately labels its method as a keyword heuristic, but the verdict is still `pass` and the oracle promotes it to a successful answer check. The distinction between textual hints and implementation evidence is lost at the verdict boundary.

**Implementation:** make keyword hits a review signal. Require syntax/AST evidence for structural checks and executable behavioral fixtures for semantic passes. At minimum, comments, strings and empty declarations must not satisfy implementation obligations.

**Acceptance:** comment-only, TODO-only, dead-code and deliberately incorrect examples do not pass implementation quality. Preserve keyword coverage as a separately named diagnostic field rather than deleting useful heuristic information.

### FR-012 — An empty target-language fence can validate code in another language

**Priority/evidence:** P1, reproduced. **Targets:** `src/shared/code-grading.ts::gradeCodeExample`.

An empty `ts` block followed by a Python `print(1)` block passes when TypeScript is requested. `languageOk` checks whether any fence has the expected tag, while `hasCode` checks whether any block contains content. Core behavior matching combines all blocks, so the same cross-block mismatch can occur with rubrics.

**Implementation:** evaluate content and behaviors within the selected nonempty target-language artifact. Allow supporting configuration/test blocks explicitly without using them to satisfy the implementation language requirement.

**Acceptance:** empty target fences, mislabeled syntax and behavior keywords found only in another-language block fail or require review. Multi-file valid examples with JSON configuration and TypeScript source continue to pass the appropriate structural checks.

### FR-013 — Invalid rubric or behavior IDs silently weaken grading

**Priority/evidence:** P1, reproduced for behavior filters; source-confirmed for unknown rubric lookup. **Targets:** `gradeCodeExample`; `debug-runs/oracle.ts` code-example branch; scenario validation.

A behavior filter containing only `typo` removes every rubric behavior and lets arbitrary fenced code pass. An unknown rubric can resolve to undefined and similarly remove expected checks. Configuration mistakes should not turn a difficult case into an easier pass.

**Implementation:** validate rubric IDs and behavior labels when a run is planned. A requested nonempty behavior set must resolve completely. Record a harness/configuration failure rather than an agent defect or pass when evaluation criteria are invalid.

**Acceptance:** misspelled IDs, empty resolved filters, duplicate labels and incompatible versions produce actionable setup errors. Valid explicit subsets retain their exact semantics and are recorded in the result provenance.

### FR-014 — One passing verification can support “all tests passed” despite a later failure

**Priority/evidence:** P0, reproduced. **Targets:** `electron/main/services/debug-runs/oracle.ts::PASS_CLAIM` check.

The oracle uses `verifications.some(ok && !skipped)`. The recorded probe supplies a pass followed by a failure and the answer “All tests passed”; the claim check returns `ok:true`, with actual evidence “passed, failed.” This is a false positive in a feature intended specifically to stop unsupported completion claims.

**Implementation:** associate claims with named commands and workspace revisions. A broad “all tests passed” claim requires the relevant final verification set to pass. A failed check may be superseded only by a successful rerun of that check against the applicable final revision.

**Acceptance:** pass-then-fail fails; fail-then-successful-rerun can pass; lint success cannot justify a test success claim; a source edit after the last test invalidates an unqualified final verification claim.

### FR-015 — Any changed file is enough to support a claimed implementation

**Priority/evidence:** P1, source-confirmed. **Targets:** `debug-runs/oracle.ts::CHANGE_CLAIM`; scenario expected paths/checks.

The generic claim guard only requires `changedPaths.length > 0`. An unrelated README change can support “I implemented authentication” unless the scenario separately specifies meaningful file/content checks. Existing requiredPaths and evaluateChecks are useful but optional, and their absence must not be interpreted as feature completion.

**Implementation:** link each implementation obligation to relevant diff evidence and behavior checks. Label generic diff presence as “a change occurred,” not “the requested change is supported.” Prefer scenario-owned expected behavior over exact implementation snapshots.

**Acceptance:** unrelated edits, whitespace-only edits and deletion of failing tests cannot substantiate a feature-completion claim. Correct implementations using different internal designs can pass the same observable contract.

### FR-016 — Claim detection is too dependent on exact English wording

**Priority/evidence:** P2, source-confirmed limitation. **Targets:** `debug-runs/oracle.ts` claim expressions.

Claims such as “Authentication is now implemented” or “Everything is green” need not match the current subject/verb forms. Conversely, quoted examples or a sentence denying a claim can contain the same tokens. Regexes are useful diagnostics, but should not become the sole truth criterion for final status.

**Implementation:** produce a structured completion record from observed tool/verification state and render the summary from it. Keep free-text claim checking as a secondary consistency check with explicit uncertainty and quoted-span handling.

**Acceptance:** cover passive voice, negatives, quotations, partial completion, multiple languages and references to earlier turns. Evaluation should remain correct even when the final prose contains no conventional success phrase.

### FR-017 — Timeouts are automatically classified as environment failures

**Priority/evidence:** P2, source-confirmed. **Targets:** `debug-runs/evaluation.ts::outcomeClass`.

Every timed-out result is classified as environment. A model/backend outage can justify that label, but a repeated-tool loop, excessive orchestration, or a deadline that never reaches the next stage can be an agent or harness defect. Automatically removing those from the agent-defect category can conceal the same stuck behavior the user reported historically.

**Implementation:** record the deadline owner, last progress, model wait time, tool wait time and repeated-work evidence. Classify ambiguous timeouts as unknown/mixed, preserving the raw terminal cause.

**Acceptance:** a deliberately stalled provider, a repeated agent tool loop, an exhausted step budget and a blocked UI delivery timeout remain distinct in summary metrics. Never infer the root cause solely from the terminal status.

### FR-018 — Coverage counters do not prove the intended stage succeeded

**Priority/evidence:** P2, source-confirmed. **Targets:** `debug-runs/evaluation.ts::coverageOf`.

Delegation coverage is inferred from `/delegat/i` in timeline text, so a “delegation refused” event can look like exercised specialist work. Model-call presence does not prove a usable response arrived; a verification event may describe failure. The existing “uncovered” reporting is valuable, but counts need precise semantics.

**Implementation:** use typed stage events with attempted, entered, completed and passed counters. Count child creation, child response and parent incorporation independently. Keep scripted and observed execution evidence separate.

**Acceptance:** a refused delegation does not satisfy successful specialist coverage. A failed provider call does not establish generated-answer coverage. Reports clearly show both attempts and completed evidence without dropping failures from denominators.

## 6. Run comparison and reproducibility

### FR-019 — v1 versus v2 comparisons match zero identical questions

**Priority/evidence:** P0, reproduced. **Targets:** `src/shared/eris-dev.ts::readCaptureRecord`; `src/shared/eris-dev-compare.ts::compareCaptures`.

Legacy records without IDs receive `v1-<index>`, while new imports receive content-hash IDs. An identical question in a v1 and v2 export therefore yields zero matched, one added and one removed. This undermines the explicit feature claim that the original capture can be compared with the corrected run.

**Implementation:** migrate legacy identity using normalized question content plus duplicate occurrence, with a disclosed fallback confidence. Validate alignment against corpus metadata. Do not match by index alone when questions may have been reordered.

**Acceptance:** the original 10,000-question capture and a matching v2 run align all unique questions. Reordering preserves alignment, duplicate ambiguity is surfaced, and missing/changed questions are reported accurately.

### FR-020 — Prompt, model and tool-schema regressions are invisible to comparison

**Priority/evidence:** P1, reproduced for prompt changes; source-confirmed for other omitted fields. **Targets:** `eris-dev-compare.ts::comparable`.

Changing the system prompt from A to B while preserving intent/tool names produces an unchanged result. The comparison also omits model identity, tool parameter schemas, sampling, acceptance criteria, obligations, execution plan and context truncation. Those are exactly where many agent-quality regressions occur.

**Implementation:** compare canonical prompt blocks and normalized tool schemas using semantic hashes that remove only identified volatile fields. Add separate categories for routing, authority, context, model settings and evaluation policy. Make expanded diffs available without flooding the summary.

**Acceptance:** a changed instruction, removed required tool argument, lost obligation or different model configuration produces a visible difference. Task UUIDs and temporary root paths alone do not.

### FR-021 — Comparison ignores run compatibility and evaluation-policy versions

**Priority/evidence:** P1, source-confirmed. **Targets:** `electron/dev/main.ts::dev:compare`; `DevRunHeader`; comparison types.

The compare handler discards the first JSONL line and compares records without checking headers. Different fixtures, contexts, modes or scripted-intent settings can appear to be code regressions. A changed invariant checker can also create/removes findings even if the request is identical.

**Implementation:** show both run manifests and classify differences as controlled or confounded. Record oracle/rubric/invariant versions. Allow exploratory comparison, but require explicit compatible baselines before reporting improvement rates.

**Acceptance:** identical questions run against different projects are flagged as a fixture change. A checker-version change is distinguished from a prompt change. Missing headers and unknown schema versions receive explicit errors or a clearly marked legacy import path.

### FR-022 — Comparison truncation understates the number of changed questions

**Priority/evidence:** P1, source-confirmed. **Targets:** `electron/dev/main.ts` comparison return; `src/eris-dev/main.tsx` comparison summary.

Main truncates `comparison.changed` to 500. The renderer displays `comparison.changed.length` as the number changed and lists only 20 rows. A 2,000-question change would be described as 500 changed, while by-field counts could show larger numbers. The UI has no explicit total-versus-returned count.

**Implementation:** return totalChanged, returnedCount, pagination and truncation metadata separately. Provide a complete downloadable comparison artifact and filters for severity/family.

**Acceptance:** a synthetic 1,200-change comparison displays 1,200 total, with a clearly labeled page size. Pagination/export reaches every changed question and aggregate counts reconcile exactly.

### FR-023 — Duplicate questions and scripted variants do not have stable cross-run identity

**Priority/evidence:** P2, source-confirmed. **Targets:** `electron/dev/questions.ts::identify`; `eris-dev-compare.ts` map construction.

Occurrence counters restart on each import/chunk. The identity includes history but excludes scripted intent replies. The same text under different scripts can share a base identity, and splitting duplicate questions into separate files can create colliding occurrence IDs. Comparison Maps silently retain one record per ID.

**Implementation:** distinguish stable case ID, input-content hash, variant ID and run occurrence. Preserve explicit source IDs when present; reject duplicates or report a multiset rather than overwriting. Include resolver script and configuration in variant provenance.

**Acceptance:** duplicate prompts across chunks remain distinct, reordered scripted variants align correctly, and duplicate result IDs cannot silently change the denominator.

### FR-024 — Installed builds cannot reliably identify their source revision

**Priority/evidence:** P2, source-confirmed. **Targets:** `electron/dev/main.ts::buildIdentity`; build configuration; `agent-versions.ts`.

Build identity shells out to Git from `app.getAppPath()`. A packaged app generally has no repository there, so provenance becomes unknown. Resume checks use manually maintained routing/prompt version strings, which cannot detect a forgotten version bump or unrelated harness/schema change.

**Implementation:** inject source commit, dirty-content digest, build ID and policy versions at build time. Include relevant schema and harness fingerprints in resume compatibility. Keep unknown provenance explicit for ad hoc builds.

**Acceptance:** a packaged Eris-Dev export identifies the exact source revision without Git installed. Changed harness behavior cannot resume an old run under the same apparent identity unless an explicit compatibility migration exists.

## 7. Persistence, import and diagnostic UX

### FR-025 — Resume accepts invalid result objects as completed evidence

**Priority/evidence:** P1, reproduced. **Targets:** `electron/dev/runs.ts::resumePoint`; `readCaptureRecord`; resume handler.

A file containing `{}` is accepted as a completed result; for a one-case run, resumePoint returns next=1. The current qualification test explicitly uses `{}` as an apparently valid existing result. Later summary code assumes fields such as findingsDetail exist and can throw, or invalid evidence can be copied into exports.

**Implementation:** validate persisted records with a runtime schema and verify index, question ID, run identity and required fields against the manifest. Atomically write case records and store a content checksum. Treat invalid records as rerunnable gaps with a recorded reason.

**Acceptance:** valid JSON with missing fields, wrong case identity, wrong schema and inconsistent counts is rejected. Recovery preserves valid prior results and regenerates only affected cases under a documented policy.

### FR-026 — Cancelled questions are saved as completed and skipped on resume

**Priority/evidence:** P1, source-confirmed. **Targets:** `electron/dev/main.ts::run`; `runs.ts::resumePoint`.

When cancellation occurs inside captureQuestion, it returns a cancelled record. The loop writes it and increments completed. Resume chooses the first missing/unreadable file, so that interrupted question is treated as done and skipped. File completion and successful case capture are distinct concepts.

**Implementation:** keep attempted, persisted, terminal and retryable states separately. On resume, retry cancelled/incomplete cases by policy while preserving the earlier attempt. Avoid making the progress bar denominator imply success.

**Acceptance:** stop during an active question, restart, and resume; the interrupted question receives a new attempt rather than disappearing from coverage. Intentional terminal blocked cases remain distinguishable from interrupted work.

### FR-027 — Resume does not reserve the active-run lock during preparation

**Priority/evidence:** P1, source-confirmed concurrency risk. **Targets:** `electron/dev/main.ts::dev:resume`.

The handler checks `active`, then awaits workspace preparation and reads/writes result files before setting active. A second resume/start/import request can enter while preparation is underway. Shared global project, corpus, runDirectory and completed state make overlapping operations unsafe even if the UI usually discourages them.

**Implementation:** acquire an operation-state lock before the first await, use an operation-local immutable manifest, and release in finally. Expose preparing/running/stopping states explicitly and keep IPC enforcement independent of button disabling.

**Acceptance:** concurrent resume/start IPC calls deterministically allow one operation. Cancellation during snapshot preparation is supported, and failed preparation clears the lock without corrupting existing run metadata.

### FR-028 — Temporary snapshots can leak when preparation fails

**Priority/evidence:** P2, source-confirmed. **Targets:** `electron/dev/main.ts::prepareWorkspace`, `dev:start`, `dev:resume`.

prepareWorkspace creates a temporary directory before copying. If snapshot fails, the caller has not yet received the workspace path and its cleanup variable remains null. Resume also has failure paths after preparation without a comprehensive cleanup owner. Oversized or unreadable projects can leave source copies in temporary storage.

**Implementation:** make snapshot preparation own cleanup until it transfers ownership to the runner. Use try/finally across all resume preparation and JSONL reconstruction. Record cleanup failures without masking the primary error.

**Acceptance:** inject size-limit, permission, cancelled-copy and malformed-result failures. No abandoned snapshot remains, and the original project is untouched.

### FR-029 — Completed runs cannot be reopened from the app

**Priority/evidence:** P2, source-confirmed and documented limitation. **Targets:** `src/eris-dev/main.tsx` run list; `electron/dev/main.ts` run-selection API.

Only three stopped/interrupted runs are offered for resume. Completed runs are not selectable, and the resume handler rejects completed state. After restart, reviewing/exporting a finished run requires locating files manually. This is a major friction point for a tool intended to save evidence for later review.

**Implementation:** add a paginated run browser with a read-only open action separate from resume. Include corpus, source revision, state, counts, configuration and disk size. Keep selected run state separate from active execution.

**Acceptance:** close and reopen Eris-Dev, open any completed run, inspect a case, filter/export and compare without running it again. More than three historical runs remain accessible.

### FR-030 — Export and comparison rebuild large captures in memory

**Priority/evidence:** P2, source-confirmed scaling risk; no peak-memory benchmark claimed. **Targets:** `electron/dev/main.ts::runRecords`, `dev:export`, `dev:compare`, resume reconstruction.

Capture writes results incrementally, but sanitized export loads all records, constructs a second redacted array and joins the entire JSONL string. Comparison reads and splits a whole prior export. Resume reconstructs done records in memory. The historical export was about 75 MB; source-rich captures can be substantially larger.

**Implementation:** stream JSONL input/output with bounded buffers, incremental validation and cancellation. Compare compact summaries or hashes first, loading bodies only for selected differences. Write exports to a temporary destination and atomically finalize.

**Acceptance:** benchmark a large capture with measured peak RSS, UI responsiveness and cancellation latency. Malformed lines identify their source line without losing earlier validated records or leaving a misleading complete export.

### FR-031 — Import heuristics discard legitimate chat requests

**Priority/evidence:** P1, reproduced. **Targets:** `electron/dev/questions.ts::prepareQuestions`.

A file beginning “Fix the bug” followed by ten question-mark-ending prompts excludes the first instruction as a heading. In mostly numbered files, all unnumbered lines are dropped. Exclusions are displayed, which is good, but capture can proceed with a materially different corpus and invalid coverage denominator.

**Implementation:** preserve ambiguous lines by default, or require an explicit import normalization choice before removal. Separate known metadata headers from ordinary imperatives. Provide a preview with included/excluded counts and the ability to restore excluded records.

**Acceptance:** imperative chat messages, mixed numbering and markdown-looking user text survive by default. Known corpus headers can still be removed with an auditable normalization policy and stable source-line mapping.

### FR-032 — History is silently truncated and scripts are weakly validated at import

**Priority/evidence:** P2, source-confirmed. **Targets:** `electron/dev/questions.ts::historyOf`, `intentReplyOf`.

History messages beyond 32,000 characters are sliced silently, while main questions exceeding the limit are rejected. Intent replies accept arbitrary strings and numeric confidence before the resolver later validates them. Intentional malformed-resolver tests are useful, but should be distinguishable from an accidental invalid corpus entry.

**Implementation:** report or reject history truncation explicitly, include original/effective hashes and budgets, and make invalid-script testing an explicit case mode. Validate ordinary scripted replies against the production intent schema.

**Acceptance:** long-history imports show exactly what was omitted, and case identity reflects effective content. Intent typos and out-of-range confidence fail normal import while dedicated malformed-response scenarios remain available.

## 8. Export privacy and evidence handling

### FR-033 — Sanitization ignores credential field names in structured objects

**Priority/evidence:** P1, reproduced. **Targets:** `electron/dev/sanitize.ts::CaptureSanitizer.value`.

Sanitizing `{password:'hunter2hunter2', token:'abcdefghijklmnop'}` leaves both values unchanged. The recursive walker retains keys and sanitizes each value without key context; assignment-pattern redaction only works when the key and value appear together inside a string. This matters for nested tool arguments and future structured diagnostic records.

**Implementation:** make traversal key-aware and redact known credential fields regardless of textual assignment syntax. Combine structural rules with provider token patterns. Keep stable linkage only where it is needed for debugging.

**Acceptance:** nested objects, arrays of headers, connection strings, short passwords and mixed-case credential keys are redacted. Non-secret fields with similar names have a documented allowlist/review path to avoid destroying useful evidence.

### FR-034 — “Sanitized” is broader than the actual redaction coverage

**Priority/evidence:** P2, source-confirmed policy limitation. **Targets:** `sanitize.ts::SECRET_PATTERNS`; snapshot policy; export UX.

The current patterns cover selected token formats and assignments, not all credentials or personal/customer data. Custom header names, database URLs, session cookies and nonstandard tokens may survive. Snapshot exclusion is filename-based and does not make ordinary source files or `.vscode` configuration credential-free. This is a coverage concern, not evidence that a real secret was exported in this review.

**Implementation:** define and display a versioned redaction policy with known limitations. Add structural URL/header handling and a local preview/review step. Prefer sanitized export by default while retaining an explicit raw evidence option.

**Acceptance:** a synthetic corpus of representative secrets is fully evaluated with expected redactions and known exclusions. The UI describes the result as automated redaction, not a guarantee that all sensitive data was removed.

### FR-035 — Redaction markers expose deterministic short hashes of secrets

**Priority/evidence:** P2, source-confirmed design risk. **Targets:** `CaptureSanitizer.token`.

Markers use the first eight hex characters of an unsalted SHA-256 of the value. This preserves linkage, but permits dictionary checks for low-entropy values and creates a 32-bit collision space. Repeated exports also reveal cross-run equality even when that linkage is unnecessary.

**Implementation:** use an export-scoped keyed digest or opaque token mapping, with adequate collision resistance. Make any cross-export linkage an explicit requirement and keep its key private. Preserve idempotence of already-redacted content.

**Acceptance:** identical secrets within one export map consistently; unrelated exports need not share markers; low-entropy values cannot be validated from a public deterministic hash alone. Counts and manifests remain reproducible within the chosen scope.

### FR-036 — Retention and artifact storage need lifecycle controls

**Priority/evidence:** P2, source-confirmed design gap. **Targets:** capture directory management; run browser; diagnostic artifact export.

Each capture retains per-case JSON and a JSONL copy, while manifests preserve questions and configuration. There is no retention policy or completed-run management UI. Large repeated captures accumulate disk usage and potentially sensitive source excerpts. Resume makes durable state more useful, but also makes lifecycle management necessary.

**Implementation:** display storage size, provide export/archive/delete actions, and add configurable retention by age/size without deleting active or pinned runs. Distinguish raw private artifacts from sanitized sharing copies.

**Acceptance:** storage accounting matches files on disk; cleanup never removes active evidence; users can archive a complete run and reopen its metadata after cleanup. Deletion failures are visible rather than silently ignored.

## 9. Production qualification beyond the original corpus

### FR-037 — Extend deterministic corpus testing through the actual request boundary

**Priority/evidence:** P1, coverage gap. **Targets:** `tests/agent-regression-suite.test.ts`, `tests/eris-dev.test.ts`, `captureQuestion`.

The original corpus is valuable for cheap interpretation coverage, but its current full sweep does not compile every prompt or inspect every tool manifest. Named boundary cases catch some integration mistakes; FR-001 shows why helper reconstruction is insufficient for broad claims.

**Implementation:** run the shared production request pipeline over the full corpus under deterministic adapters, in bounded chunks if needed. Persist counts by intent, artifact, authority, invariant, resolver source and context size. Keep this distinct from response-capable evaluation.

**Acceptance:** every case has a result or explicit reason for not reaching the boundary; sum totals exactly to 10,000. A production-only change cannot evade the suite simply because helper behavior stayed constant. Timing is labeled pre-inference only.

### FR-038 — Add a genuinely held-out routing and constraint corpus

**Priority/evidence:** P1, coverage/design gap. **Targets:** corpus fixtures, scenario labels, release qualification reports.

The 10,000 questions are generated from repeated topic/wording families, and the fixes target those families directly. Zero collisions there is useful regression evidence but weak generalization evidence. Real IDE chats include commands in backticks, selective prohibitions, partial references, pasted failures, mixed languages and compound requests.

**Implementation:** maintain a separately labeled holdout set from de-identified real failures and adversarial paraphrases. Split by wording family and topic rather than random rows. Label acceptable artifacts and authority, allowing multiple valid agents.

**Acceptance:** evaluation reports development versus holdout results separately, includes disagreements/unknowns, and avoids declaring every heuristic candidate a defect. Add each confirmed production regression as a durable case without repeatedly tuning on the entire holdout.

### FR-039 — Turn topic rubrics into executable behavioral fixtures

**Priority/evidence:** P1, coverage/design gap. **Targets:** `topic-rubrics.ts`, `code-grading.ts`, diagnostic scenario infrastructure.

Forty topic matchers cover the corpus's vocabulary, but keyword presence does not test tenant isolation, restoration, expiry, retry bounds, authorization or concurrency. Existing diagnostic verification is scripted or skipped; it is not execution of generated example code.

**Implementation:** start with a compact high-value set of language-specific isolated fixtures: soft deletes, password reset, rate limiting, idempotency, authorization, pagination, retry/backoff and upload validation. Define inputs and observable outcomes independent of implementation structure. Use disposable environments with bounded resources.

**Acceptance:** plausible wrong implementations fail; correct alternative designs pass. Reports distinguish syntax validity, behavioral tests and human/security review requirements. A scripted verifier response cannot be reported as an actual generated-code test.

### FR-040 — Real-model diagnostics need an explicitly bounded verification mode

**Priority/evidence:** P1, source-confirmed coverage gap. **Targets:** `debug-runs/coordinator.ts` diagnostics scope and verification handling.

The coordinator explicitly refuses host commands and supplies scripted verification results in simulations, skipping verification in real-model runs. This is an intentional containment boundary, but means a live model can produce a patch without the harness proving it runs. The current user goal of production-ready agent behavior requires a stronger optional evidence mode.

**Implementation:** add isolated fixture execution with preapproved commands, time/memory/output limits and resettable state. Keep the existing no-execution mode. Attribute every verification result to scripted, replayed or actually executed provenance.

**Acceptance:** a broken generated patch fails an executed fixture test, a working one passes, and a verification timeout is reported with the command and resource cause. No arbitrary host command authority is introduced merely to run diagnostics.

### FR-041 — Exercise real child-agent lifecycles and parent integration

**Priority/evidence:** P1, source-confirmed coverage gap. **Targets:** capture and diagnostic `allowDelegate:false`; child task contracts; scheduler and gateway.

Both inspected diagnostic entry paths disable delegation. Unit tests of child authority inheritance are valuable, but they do not demonstrate scheduling, cancellation, stale scope, conflicting edits or incorporation of a specialist's result. Those are central to the user's agent-to-agent concerns.

**Implementation:** add a deterministic multi-agent fixture mode using the production scheduler and scripted model adapters. Give each child a bounded assignment and immutable parent revision. Record parent/child IDs, authority, artifact ownership, result acceptance and merge conflicts.

**Acceptance:** cover child failure, timeout, late result, cancellation, overlapping file changes and attempted authority expansion. The parent must not claim a delegated change before inspecting/applying its evidence, and no orphan work continues after cancellation.

### FR-042 — Test desktop chat delivery and visible final artifacts

**Priority/evidence:** P1, explicitly uncovered today. **Targets:** renderer chat components, preload/IPC, stream store, posted-answer pipeline.

Coverage reports correctly list desktop chat UI delivery as uncovered. That means green orchestration tests cannot exclude a sent message being lost, a response rendered in the wrong thread, an empty final bubble, or a Send button staying disabled. FR-010 also shows why preserving model output all the way to the visible artifact matters.

**Implementation:** add a compact Electron UI smoke suite driven by deterministic production transport adapters. Submit actual chats through the composer, observe streamed status and final content, and assert persistence/reload behavior. Include concurrent threads and cancellation.

**Acceptance:** submit → agent routing → model request → tool result → final answer → reload is exercised with traceable request IDs. JSON/code blocks remain visible, edits match the active project, and every submitted message has a terminal delivery outcome.

### FR-043 — Qualify provider serialization and local model protocol compatibility

**Priority/evidence:** P1, coverage/design gap. **Targets:** common model transport, provider adapters, local worker, tool protocol selection.

Eris-Dev stops before provider-specific serialization and tokenization. A coherent common request can still become an invalid native-tool message, lose roles or exceed a real model context after adapter processing. This review did not invoke a provider and makes no claim that a particular adapter currently fails.

**Implementation:** add adapter contract tests for tool-call IDs, tool-result ordering, system/user roles, JSON schema, cancellation and streaming fragments. Capture redacted serialized request metadata in an optional diagnostic mode. Exercise text-tool local models separately from native function-calling providers.

**Acceptance:** the same canonical task has valid provider-specific messages; malformed/partial tool calls produce recoverable protocol errors; output limits and context accounting reflect the chosen model's capabilities. Live tests remain explicitly configured and budgeted.

### FR-044 — Follow-up scenarios need scope changes, long histories and stale evidence

**Priority/evidence:** P1, coverage/design gap grounded in current intake rules. **Targets:** conversation state, task-intake prior scope, resolver history slicing, context compilation.

Current multi-turn scenarios and stable task state are improvements, but references can span more than the resolver's last six messages, which are each truncated to 1,200 characters. Prior project inheritance uses a small vocabulary of reference words and an existing prior scope. Changes to the selected workspace or to recommendations can make old evidence misleading.

**Implementation:** maintain a compact structured conversation state with task/recommendation IDs, user-selected scope, superseded decisions and current obligation status. Feed that state to resolution instead of relying on prose prefixes alone. Revalidate scope and evidence before mutation.

**Acceptance:** cover review → partial implementation → changed workspace → “finish the rest,” explicit project switches, deleted projects, and late child results. A long explanation between turns must not erase the user's selected recommendations or resurrect superseded ones.

### FR-045 — Build and release reports need precise, durable qualification evidence

**Priority/evidence:** P2, source-confirmed maintainability gap. **Targets:** package scripts, `.github/workflows/ci.yml`, release workflow, qualification artifacts.

The test gate is a manually enumerated list. CI runs all tests and then build runs the selected suites again. Green console output does not provide a durable before/after capture report, corpus hash, failure taxonomy, or record of which live checks were not run. The `start:app` shell command also places quit/open operations after a semicolon, so those operations can run after an earlier build failure; this is a pre-existing build workflow risk.

**Implementation:** define named qualification profiles with machine-readable manifests, emit a versioned report artifact, and require successful packaging before replacing/relaunching the local app. Keep lightweight deterministic PR gates separate from scheduled/budgeted live qualification, without implying the latter ran when it did not.

**Acceptance:** each build report names commit, corpus, test profile, counts, uncovered stages and artifact links. A failing build cannot relaunch an older binary as apparent success. New suites cannot silently miss the profile, and Windows/macOS behavior is qualified before release rather than discovered only while uploading installers.

## 10. Implementation sequencing and boundaries

### Batch A: close false confidence and direct product regressions

Implement FR-001/002 together so the test observes the production defect before the fix. Then FR-003/004/005 address effect authority and quoted operands, and FR-010 protects visible code output. These changes should be small enough to review independently but use common production contracts. Do not add another regex-only routing path just for diagnostics.

In parallel planning terms, FR-014 and FR-019/025 are the next high-value evidence fixes: verification claims, legacy alignment and resume integrity. They can be implemented separately because their acceptance tests do not require live model responses. Each PR should include a failing counterexample, a behavioral fix and one meaningful positive contrast.

### Batch B: make evidence trustworthy across runs

Implement FR-020–024 for comparison/provenance, FR-026–030 for persistence and bounded resource use, and FR-033–036 for export handling. Update schemas with migrations and explicit compatibility rules. Preserve old exports; do not rewrite the original evidence to make current counts look better.

### Batch C: improve completion quality

Implement FR-007–009 for recommendation selection and accounting, FR-011–018 for grading and evidence taxonomy, and FR-037/038 for production-boundary and holdout coverage. A green keyword heuristic should not become a live task-success metric. Keep labeled uncertainties and ambiguous cases visible for adjudication.

### Batch D: qualify production behavior

Add FR-039–044 incrementally, beginning with a small deterministic end-to-end set. Expand to real models only after budgets, isolated fixtures, result provenance and cleanup are reliable. The original 10,000 prompts are useful input coverage, but they do not need to be sent blindly to paid or local inference to establish that a targeted fix works.

Suggested release-quality evidence includes: actual submitted message delivery; coherent task/authority; valid serialized model request; observed tool effects; revision-bound verification; a final answer supported by those effects; and persisted traceability. Report each dimension independently rather than collapsing everything into one “agent pass rate.”

## 11. Instructions for the next implementing model

Read the current source and any local repository rules before editing. This document is a backlog, not permission to publish, spend inference budget, or run unbounded commands. Preserve the existing task gateway, effect ceilings, diagnostics isolation, cancellation and workspace binding.

For each selected FR item:

1. Reproduce the specific condition against the current source. Reconfirm it if the revision has changed.
2. Add an assertion for the intended behavior at the layer where the bug reaches the user; avoid merely mirroring a helper's implementation.
3. Implement the smallest coherent production change. Update types, persistence migrations and UI explanations together when relevant.
4. Run the focused negative case plus positive contrasts and the affected qualification profile.
5. Record changed behavior, evidence limits, remaining uncertainties and any schema/policy version change.
6. Close an item only when its acceptance behavior is demonstrated. Do not mark an entire AG stage complete because a similarly named helper or test file exists.

The 45 items above are not 45 independently observed production incidents. They comprise reproduced failures, source-confirmed integrity/coverage risks, and explicit design work. The historical 10,000-request export does not contain answers, and this follow-up did not generate 10,000 model responses. That distinction is essential to using this document responsibly.

## 12. Companion evidence

- `backlog.json`: all 45 work items with priorities, implementation guidance and acceptance criteria for other models.
- `probe-results.json`: executable counterexamples, all 134 resolver-bypass discrepancies, and two production-boundary capture summaries.
- `review-followup-probes.test.ts.txt`: probe source, archived outside the normal test glob. To reproduce, copy it to `tests/review-followup-probes.test.ts`, run that one Vitest file from the repository root, then remove the temporary test file. It writes probe-results.json; it does not call real models.
- `validation.txt`: recorded focused test and probe output.
- `manifest.json`: reviewed revisions, evidence counts and artifact hashes.

Probe output contains generated UUIDs and timings; these are not stable expected values. Fixtures use temporary directories and are cleaned up by the probes. The checked-in probe archive is evidence for this review, not an added permanent build gate; implementing models should turn the relevant examples into intentional regression assertions.
