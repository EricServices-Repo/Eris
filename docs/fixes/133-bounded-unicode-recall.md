# #133 — bounded, Unicode and code-aware recall

Recall used to lowercase every retained message on every query, test substrings, check a linear exclusion array per row and re-sort the candidate list once saturated. Query parsing dropped non-ASCII terms and anything of two characters or fewer, so Unicode, CJK, Go and C# could not be recalled, and substring matching conflated unrelated identifiers.

Terms now come from `src/shared/recall-terms.ts`, which handles:

- Unicode letters and numbers, with case and Latin diacritic folding
- CJK bigrams
- camelCase, snake_case and hyphen splitting, plus a joined identifier term
- paths and file names as exact terms
- light plural folding
- symbol names such as `C#` and `C++`
- two-character names such as `Go`, kept only when capitalized, so prose such as "go ahead" does not match

The workspace worker prepares terms with each page, so main does not tokenize hydration pages. Single appended messages are tokenized on main. Each record is capped at 2,048 terms, and term storage is charged to the record's logical bytes.

Each thread now has an inverted index (`RecallIndex`), maintained on install, append and trim. A query reads at most the newest 2,048 postings per term and 24 query terms. Exclusions use a Set. Top-K compacts at twice K, so candidates stay bounded and the list is sorted rarely. Only the top 128 rows materialize excerpts, and those excerpts are exact slices of the original text. The existing one-excerpt-per-source rule supplies source diversity, and `manifest.rankingVersion` identifies the ranking.

A split identifier matches on its whole form (16 points) or on all of its parts (8 points). A query path or file name must match exactly, so `src/auth/login.ts` no longer matches another file by sharing `src`. Salience and recency bonuses are unchanged, so a salient user message can still be recalled with no term match.

## Measurements

Scripted runs on one Apple Silicon Mac under Node, not a gate and not packaged, Windows or hardware-pressure evidence. The same `store.select` script ran on `main` and this branch, with a 2.6 KB code-shaped message, 5,000 exclusions and 15 warm queries. A thread retains about 10,000 of these messages under the default accounting at the 128 MiB cap, so the last row retains the same set as the second.

| Messages offered | p50 before | p50 after | Max before | Max after |
| --- | --- | --- | --- | --- |
| 1,000 | 10.6 ms | 2.2 ms | 13.5 ms | 3.7 ms |
| 10,000 | 85.7 ms | 2.7 ms | 90.9 ms | 3.5 ms |
| 25,000 | 83.1 ms | 2.7 ms | 89.8 ms | 3.9 ms |

Allocation per query, measured as heap growth across one `select` after two forced GCs with a 2 GiB young generation, so no collection falls inside the sample: median 8.34 MiB before and 4.07 MiB after on 10,000 messages, with the same median across three separate processes of 12 samples each (8.34 to 8.37 MiB before, 4.07 MiB after). An earlier attempt over 15 consecutive queries was dominated by GC timing and is not used.

The labeled quality fixture in `tests/recall-quality.test.ts` has 14 cases with exact expected and distractor source IDs. On `main`, 3 of 14 cases pass (expected source recalled, distractor excluded), with 5 recalled and 2 distractors returned. On this branch, 14 of 14 cases pass (expected source recalled, distractor excluded), with 14 recalled and 0 distractors returned. These are synthetic labels written for this change, so they show the targeted behaviors work. They do not estimate real-world recall.

Added cost: worker tokenization took about 96 µs per 3.8 KB message on a mixed fixture, about 48 ms for a 500-message page. A cold 25,000-message hydration therefore adds up to about 2.4 s of worker CPU across pages. Retained term data is charged against the same thread cap, so slightly fewer messages stay resident.

Remaining limits:

- A posting list of a very common term reads only its newest 2,048 rows, so older matches of that one term are not ranked.
- There is no stemming beyond plurals, so `check` no longer matches `checkout` through substring luck.
- Scripts without spaces other than CJK (Thai, for example) are indexed as whole runs.
- `recall-terms` runs on main for appends and for any record arriving without terms.

Validation: `npx vitest run tests/recall-quality.test.ts`, and the full suite. Deterministic scripted checks; no live model was involved. Moving the index itself off main is #132.
