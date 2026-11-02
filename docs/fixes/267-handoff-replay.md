# #267 — replay a real task tree in CI

Each handoff fix had its own unit tests, and tiered gates read journals directly. Nothing ran a coordinator, its children and an unrelated request together, so a green score did not show that a child received a fact.

`tests/handoff-replay.test.ts` runs that tree through the production scheduler, `parseHandoff`, `childTaskContract`, the compiler, evidence revalidation and `streamModelChat`. Only the provider adapter and the tool loop are scripted.

| Family | Scenario                                                                                 | Passes only if                                        |
| ------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| HR-001 | A concurrent request repeats the parent's private text while a lease is live and revoked | Its message reaches the adapter unchanged             |
| HR-002 | A queued child after the parent left, with and without a forget                          | Forgotten: no model call. Unchanged: the fact arrives |
| HR-003 | A subgoal omits the language                                                             | `"language":"Python"` is in the dispatched contract   |
| HR-004 | A required constraint beside a crowded briefing                                          | The constraint is dispatched                          |
| HR-005 | A forget lands during model preparation                                                  | The fact is absent from the request                   |

Two more rows cover a child stopped while queued, and a store emptied by pressure followed by a cold reload.

- **No credit from helpers:** `dispatchedMarkers` is computed only from what the adapter received. `evaluateHandoffReplay` fails if a required marker is missing or a forbidden one is present.
- **Accounting:** each row is exported with parent and child IDs, context origin, selected sources, outcome, model calls and dispatched characters. A completed row with no model call fails, and so does a blocked row with one.
- **Label:** the report is `deterministic-scripted`, and any other label fails.
- **Isolation:** temp data root, no credentials, no network. A diagnostics run still cannot enqueue a job, and the suite asserts that.
- **Export:** `out/qualification/handoff-replay.json`, uploaded by CI.

The suite is in the `agents` profile, so it gates `npm run build`.

## Mutation check

Each fix was removed in turn and the suite run:

| Removed                                            | Result |
| -------------------------------------------------- | ------ |
| Scope check in `leasesFor`                         | Fails  |
| `runWithHandoffEvidence` evidence                  | Fails  |
| Language inheritance                               | Fails  |
| Constraint carrying in `inheritRequirements`       | Fails  |
| Final `withEligibleMemory` in `streamProviderChat` | Fails  |

The first version of HR-003 stayed green, because "Python" also arrives in the parent's request text. It now checks the contract field.

## Not done

- **Eris-Dev:** there is no ephemeral scheduler in Eris-Dev. The diagnostics guard still refuses background work, so this runs in CI only.
- **Live cases:** no opt-in live-model or hardware cases.
- **Inline children:** the replay covers queued children. Inline delegation shares `handoffMessages` and the contract, but its loop path is not replayed.
- **Scripted loop:** the runner compiles and sends once. It does not run tools or the real agent loop.
- **Typed outcomes:** child outcomes returned to the parent are not asserted here. `tests/child-outcome.test.ts` covers them.

Verification: `npx vitest run tests/handoff-replay.test.ts`.
