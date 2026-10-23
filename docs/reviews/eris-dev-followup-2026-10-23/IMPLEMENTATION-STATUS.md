# Follow-up review: implementation status

Implemented on `agent-improvements-stage6` on top of `92f3e68`. Each item has a counterexample from the review and a positive contrast at the layer where the problem reaches the user. The tests are in `tests/agent-followup-review.test.ts`, `tests/eris-dev-followup.test.ts`, `tests/agent-corpus-boundary.test.ts`, `tests/agent-regression-suite.test.ts` and `tests/chat-stream-diagnostics.test.ts`.

Validation: `npm run typecheck` is clean and `npx vitest run` passes 74 files and 739 tests. `node scripts/run-qualification.mjs agents` passes 594/594 and `node scripts/run-qualification.mjs dev-app` passes 73/73. `electron-vite build` succeeds for both the main app and the dev app. No provider or local model was called, and nothing was published or released.

Version changes: `ROUTING_VERSION` and `PROMPT_VERSION` are now `2026-10-23.5`. New: `INVARIANT_VERSION 2026-10-23.2` and `EVALUATION_VERSION 2026-10-23.2`. The redaction policy is now `eris-dev-redaction-v2`. Run headers now record `versions.invariants`, `versions.evaluation` and `versions.harness`, plus `app.dirtyDigest`, `app.buildId` and `app.provenance`.

## Status by item

| Item | Status | Notes |
|---|---|---|
| FR-001 | Done | The corpus sweep runs `resolveTaskDecision` behind a scripted zero-confidence transport. It records the resolution source for every case and publishes any helper-versus-production disagreement as a list. |
| FR-002 | Done | Before any bypass grants edit authority, the resolver now checks whether the request names a destination. "How would you write it?" is no longer read as implement-changes. The 134 discrepancies went to 0. Q107 and Q413 are code-example/chat with no edit at `captureQuestion`. Named-file edits still edit. |
| FR-003 | Done | `effectConstraints` records edit, verification, execution, commit and external prohibitions separately, each with the phrase that triggered it. Intake, the classifier, the resolver guard, the response contract, the gateway (commit/push) and the invariants all use it. Scoped limits such as "without changing the public API" no longer forbid edits. |
| FR-004 | Done | `requestSpans` keeps quoted language names and paths, and turns a quoted command into an operand marker. `Run \`npm test\`` is now run. `Explain \`npm test\`` stays explore. |
| FR-005 | Done | Input that is only quoted or fenced resolves to `quoted-content-only`. No caller falls back to the quoted text any more. |
| FR-006 | Done | Source and target languages are separate. Frameworks from two ecosystems leave the language open. Ambiguity is stated in the compiled contract. |
| FR-007 | Done | Every selected recommendation becomes an obligation, plus one accounting obligation. Turn results record a state for each item, and unmentioned items are pending. A new invariant, `recommendations-truncated`, catches truncation. |
| FR-008 | Done (intake level) | `selectRecommendations` handles numbered, ordinal, named and exclusion selections. A selection it cannot resolve becomes a clarification obligation. **Not done:** a multi-turn diff assertion through the coordinator. |
| FR-009 | Done | Extraction now uses the heading an item sits under. Code, quotes and descriptive sections are excluded. IDs come from the section, the normalized text and the occurrence, not the whole answer. |
| FR-010 | Done | A fenced or bare envelope is treated as protocol only when the runtime would execute it, and only for known tools. This is tested through the real `chat:stream` handler. One older qualification test asserted the over-broad stripping and was updated. |
| FR-011–013 | Done | Grading reads code tokens with comments, strings and dead branches stripped, from the nonempty target-language block. Keyword hits are reported separately. Invalid rubrics or behaviors fail at scenario parse time and record an `evaluation_invalid` harness outcome. |
| FR-014 | Done | Pass claims need the latest result of each claimed check kind on the final workspace revision. Coordinator verifications now record the command and the sandbox digest. |
| FR-015 | Done | README, lockfile, whitespace-only and deleted-test changes do not support a change claim. A substantive diff with no scenario checks says the behavior itself was not verified. |
| FR-016 | Partial | Passive voice, negation, quotes, code and blockquotes are handled. **Not done:** a structured completion record, and claims in languages other than English. |
| FR-017 | Done | Timeouts are classified from the case's own evidence: provider stall, repeated work, user cancellation, or `unknown`. `timeoutEvidence` is stored on the case. |
| FR-018 | Done | Coverage reports attempts, completed and passed separately. A refused delegation or a failed provider call counts as an attempt only. |
| FR-019 | Done | v1 records are given content IDs. Duplicated texts are reported as ambiguous. |
| FR-020 | Done | Comparison now covers canonical prompts with volatile identifiers removed, model, sampling, tool schemas (including lost required arguments), context truncation, obligations and acceptance. Changes are grouped into categories, with short details for each. |
| FR-021 | Done | `runCompatibility` labels a comparison controlled, confounded or legacy. Missing headers and unknown formats are errors. |
| FR-022 | Done | The comparison returns `totalChanged`, pages of 200, a `dev:compare-page` call, and a saved full artifact. Tested with 1,200 changes through IPC. |
| FR-023 | Done | Explicit source IDs are kept and must be unique. Scripted variants are keyed separately. Duplicate IDs are reported instead of being overwritten. **Not done:** occurrence counters are still per import, so splitting a file into chunks can still renumber duplicates. |
| FR-024 | Done | `electron.dev.config.ts` stamps the commit, dirty digest and build ID into packaged builds. Resume requires a matching harness fingerprint. |
| FR-025 | Done | Saved case records are checked at runtime against the manifest. Case files are written atomically. Invalid records are recaptured, and the reason is recorded. **Not done:** per-record checksums. |
| FR-026 | Done | A cancelled question is kept as `<index>.attempt-N.json` and run again on resume. |
| FR-027 | Done | Resume takes the lock before its first await and releases it in `finally`. Tested with concurrent IPC calls. |
| FR-028 | Done | The snapshot step owns cleanup until it hands the workspace over. A failed start removes its empty run folder and keeps the previously selected run and project. |
| FR-029 | Done | `dev:open` opens any run read-only. The UI has a paged run browser showing revision, configuration and size. |
| FR-030 | Partial | Exports are streamed and renamed into place when complete. Comparison input is read line by line. **Not done:** comparison still holds both record sets in memory; no peak-memory benchmark. |
| FR-031–032 | Done | Imperative lines and unnumbered lines in numbered files are kept. Only headings and separators are excluded, and `include` restores them. Over-long history is rejected rather than cut. Scripted replies are validated, with an explicit `intentReplyMode: "malformed"` exception. |
| FR-033–035 | Done | Redaction now uses field names, and covers header lists, auth headers, cookies and URL passwords. A documented allowlist protects token counts. Markers are 64-bit, keyed per export, and the limitations are shown in the UI. **Not done:** a preview-before-export step. |
| FR-036 | Partial | Storage use is shown in the run browser. **Not done:** archive, delete and retention policy. |
| FR-037 | Done | All 10,000 questions go through `captureQuestion` in about 35 s, as part of the agents profile. The distribution is written to `out/qualification/corpus-boundary.json`. Current results: 0 edit/run, 0 findings, 939 bypass and 9,061 fallback resolutions. |
| FR-045 | Done | Machine-readable profiles live in `tests/qualification-profiles.json`, and every test file must be classified (enforced by a test). `run-qualification.mjs` writes a versioned report with the commit, corpus hash, counts and the stages it does not exercise. `start:app` no longer relaunches after a failed build. |
| FR-038–044 | Not started | Held-out corpus, executable rubric fixtures, bounded real-model verification, real child-agent lifecycles, desktop UI delivery, and provider serialization. These need labeled data, isolated execution environments or authorized live budgets. They are listed in each profile's `notRun`. |

## Remaining limits

- Answer quality is still unevaluated. Every result here is either pre-inference or produced from scripted model replies.
- Of the 10,000 corpus questions, 2,811 still route to `plan` with no semantic decision. Whether that is the right destination for each question needs the labeling described in FR-038.
- Grading remains a token-level heuristic. Deliberately incorrect code that uses the right words still passes until FR-039 adds executable fixtures.
