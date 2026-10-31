# #224 — compaction summaries cover the whole compacted range

The summarizer's input kept the oldest 24,000 characters, so long runs cut the newest compacted turns, which are usually the current state of the work.

`buildSummaryTranscript()` now spreads the same 24,000 characters across every compacted message, weighted linearly so the newest message gets twice the share of the oldest. Filling newest first rolls anything a short message leaves unused to older ones. Shortened messages keep both ends, because tool output usually ends with its result. If a range is too long for every message to keep at least 240 characters, the oldest are omitted.

Eris, not the model, appends a note to the brief when input was shortened or omitted, because a model cannot disclose text it never received. Execution-claim verification is unchanged, and the brief stays within 8,000 characters.

Verification: `npx vitest run tests/compaction-summary-coverage.test.ts`. No live model has been run, so the effect on brief quality is unmeasured. This limits loss until #222 keeps sources recoverable.
