# #139 — pack coherent evidence units with conservative accounting

The compiler budgeted a fixed three characters per token and sliced optional blocks at an arbitrary character. CJK and other dense text could use about three times its budget, and a cut could end mid-fact, mid-citation or inside a code fence.

Budgets are now kept in ASCII-equivalent units (`src/shared/token-estimate.ts`). ASCII text costs what it always did, so English and code budgets do not change. Non-ASCII text costs one token per UTF-16 code unit. The compiler, the provider budget and compaction triggers use the same measure.

Recalled memory is packed as whole items in priority order. An item that does not fit is omitted with a reason, and a later smaller item may still use the remaining room. The header is dropped when no item fits, so `truncated` no longer occurs at compile time for memory. Project and retrieval evidence is cut at the last whole line, or last word of one long line, never inside a surrogate pair, and never leaving a code fence open. If no complete unit fits, the block is omitted.

Required task and instruction blocks still either fit or fail before generation, now measured by their real cost. Provider budgeting still shortens only old tool results and validates tool-call pairing.

`context-dispatched` now records a conservative request estimate. A new `context-usage` event pairs that estimate with provider-reported prompt tokens when available, and is labeled `provider-measured` or `estimate-only`, so an estimate is never presented as a measurement.

Limits:

- This is a conservative estimate, not an exact tokenizer. Dense ASCII such as minified code can still exceed three characters per token. It has not been calibrated against a real backend, so #139's "exact or calibrated" requirement stays open.
- Tool schemas and output were already reserved in `streamProviderChat`; this change did not alter those reservations.
- Blocks stay in the same order and share rules, so the 55% system share and 40% historical cap are unchanged.

Validation: `npx vitest run tests/context-packing.test.ts`. Deterministic checks of the estimate, boundaries, item packing, CJK budgets, required-context failure, provider budgeting, one-shot, tool and recovery adapters, and usage labels. No live model, so no estimate was compared with a real tokenizer.
