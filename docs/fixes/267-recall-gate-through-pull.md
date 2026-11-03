# #267 — Post-compaction recall gate measured through context_search/context_read

One acceptance item of #267: "No child-fact success is credited merely because a
test helper enumerated the journal directly."

## Defect

`checks/tiered-gates.ts` `measureRecallAfter` plants facts in tool outputs, compacts
1, 3 and 10 times, then counted a fact as recovered if **any** journal entry
contained it. It did this by calling `journal.list()` and `journal.read()` on every
entry. A model cannot do that. It sees eviction stubs and must find the fact with
`context_search`, then read a ref that search returned with `context_read`, subject
to the destination policy, repeated-call rule and per-run read budget. The gate,
which blocks CI and release builds, could therefore pass while the model-facing path
returned nothing.

## Change

Recall is now measured through a real `ContextPull` over the run's journal:

1. `context_search` for the fact (`scope: 'run'`).
2. Choose the result line that shows the fact, as a model reading the results would.
3. Page that ref with `context_read`, following the `Continue with offset N` hint,
   capped at 12 pull calls per fact.

`recovered` counts only facts returned by step 3. Each row now also reports
`pullCalls`, `refusedPulls` and `searchRanks`, the fact's position in its own
results.

## Result (scripted)

| Compactions | Planted | Recovered via pull | Pull calls | Refused | Search ranks |
| ----------: | ------: | -----------------: | ---------: | ------: | ------------ |
|           1 |       3 |                  3 |         12 |       0 | 3, 2, 1      |
|           3 |       3 |                  3 |         12 |       0 | 3, 2, 1      |
|          10 |       3 |                  3 |         12 |       0 | 3, 2, 1      |

The gate still passes, now for a reason a model could reproduce.

**Search-quality observation.** `searchTerms` drops one-character terms, so
`PLANTED-FACT-0`, `-1` and `-2` are the same query and tie at score 2. Ties break
newest first, which puts `PLANTED-FACT-0` third in its own results. Recall survived
only because the right line was still within the top five. Queries that differ by a
single digit ("test 3", "error 5") behave the same way. Scoring was not changed
here.

## Limits

- **Recoverability still reads by ref directly.** `measureRecoverability` calls
  `journal.read(ref)` with the ref printed in each eviction stub, not via
  `context_read`. Routing 200 results through the pull path would measure the
  per-run read budget rather than recoverability.
- **The rest of #267 is not done.** The ephemeral task-tree scheduler, child dispatch
  capture, the five HR failure families, and live or hardware cases (required items
  1–3) are not addressed.
