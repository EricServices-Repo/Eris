# #147 — add a release gate for RAM-context performance

Passing test counts could not show that larger histories stay efficient, and the architecture's targets had no harness behind them.

`npm run check:context` runs the production `ContextMemoryStore` over deterministic 1k, 10k, 25k and 100k corpora of 2 KiB code turns, long metadata, Unicode and decisions, then writes `out/qualification/context-gate-performance.json`, which CI uploads with the other performance reports. It runs in CI before the existing performance budgets.

The report keeps:

- **Identity:** corpus hash, git commit, hardware, runtime and ranking version.
- **Denominators:** messages offered and retained, queries and samples. Retention is shown because the thread cap can hold fewer messages than offered.
- **Measured:** per-query latency quantiles, cold install time and a heap delta.
- **Estimated:** the #131 ledger, labeled as an estimate.

The gate evaluates each size and query alone, so one regression cannot hide in an average. It fails on a query's p95 growing past 12x the smallest corpus, a dropped labeled recall case, an empty denominator, a missing hash, a ledger over its envelope or transient bytes left held, and an incomplete or unfingerprinted live-model claim. A query with no samples fails rather than reading as fast.

Absolute latency budgets apply only to a matching hardware profile. `checks/performance/context-budgets.json` has none yet, so this is reported as not evaluated, never as passed. One Mac run is not a baseline to hold other machines to.

Results from one Apple M4 run (Node, not a budget):

| Offered | Retained | Cold install | Worst query p95 |
| --- | --- | --- | --- |
| 1,000 | 1,000 | 33 ms | 2.5 ms |
| 10,000 | 10,000 | 216 ms | 2.7 ms |
| 25,000 | 16,703 | 484 ms | 3.4 ms |
| 100,000 | 16,672 | 2,277 ms | 4.5 ms |

Limits:

- The harness measures store selection on the calling thread. It does not measure main-process event-loop latency, the full compile path or queue timings.
- Cold install here excludes worker term preparation, so it understates real hydration.
- Heap deltas are one-query samples, recorded but not gated.
- No live-model A/B or packaged run exists. Recall is the 14 synthetic labeled cases from #133, which show targeted behaviors and do not estimate real recall.
- Windows runs the gate only if CI reaches this step on that platform; no Windows budget exists.

Validation: `npx vitest run tests/context-release-gate.test.ts` and `npm run check:context`.
