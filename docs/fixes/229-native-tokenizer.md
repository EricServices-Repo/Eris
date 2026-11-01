# #229 — Native tokenizer counts for context packing

`resolveModelCapabilities()` claimed `native-tokenizer` for every GGUF, while the compiler packed at a fixed 3 characters per token. Measured against `model.tokenize()`, that estimate is off in both directions:

| Content       | Estimate ÷ real, Qwen2.5-Coder 1.5B | Qwen3.5 4B |
| ------------- | ----------------------------------- | ---------- |
| Prose         | 1.67                                | 1.62       |
| Code          | 1.44                                | 1.33       |
| CJK           | 1.58                                | 2.00       |
| Minified JSON | 0.77                                | 0.77       |
| Base64        | 0.45                                | 0.45       |
| Hex           | 0.38                                | 0.38       |

Above 1 wastes window. Below 1 overruns the budget, which is the worse failure.

## What changed

- **RPC:** the worker handles `tokenize` outside its generation queue, and the reply names the model that counted, so a count cannot land under the wrong tokenizer during a model switch. Main batches at 64 KiB.
- **Cache:** `agent/token-count.ts` keys counts by SHA-256 of the text, tokenizer identity and a version. Identity is the model ref plus the GGUF's size and time. The cache holds digests and numbers, no prompt text, up to 8,192 entries. It is in memory, so a runtime upgrade cannot leave stale counts.
- **Packing:** `compileMeasuredContext()` counts the candidates, compiles, counts the exact result, and packs tighter if it came in over, at most three times. The compiler stays synchronous and reads counts from the cache. A cut has no count of its own, so it is priced at its block's density until the final count.
- **Record:** `bundle.tokenizer` and `budget` state `native-tokenizer` with the exact count, or `characters` with a `fallback` of `no-local-tokenizer`, `model-not-loaded` or `tokenizer-unavailable`. `tokenCounting` now reports `native-tokenizer` only while that model is resident.
- **Deadline:** a send waits at most 250 ms for counts, then uses the estimate and records it. A failed tokenizer never fails a send.
- **Stricter stop:** real counts also apply to the required blocks, so instructions that only looked small enough now stop before dispatch, as §14.2 requires. This can fail a send that would previously have gone out, and overrun, on dense guidance.

`buildPreservedWorkerMessages()` became async. The estimate path produces the same text as before.

## Live measurement

Real tokenizer, Qwen2.5-Coder 1.5B on Apple M4 Metal, in process. Percentages are of the system message limit.

| Content       | Limit  | Estimate pack | Measured pack |
| ------------- | ------ | ------------- | ------------- |
| Prose         | 18,022 | 61%           | 98%           |
| Minified JSON | 18,022 | 136%          | 98%           |
| Hex           | 18,022 | 267%          | 100%          |
| CJK           | 18,022 | 61%           | 100%          |
| Code          | 4,400  | 70%           | 98%           |

The documented margin: every measured pack was at or under the limit, and the recorded count equalled `model.tokenize()` of the message exactly. Packs filled 94–100% when source outran the limit. The chat template's few tokens are not in that count. Code at the larger limit stayed at 29% only because the source file ran out.

Latency for a compile over a 100 KB source, 40 runs:

|                  | p50     | p95     |
| ---------------- | ------- | ------- |
| Estimate only    | 1.1 ms  | 1.2 ms  |
| Measured, cold   | 50.8 ms | 53.3 ms |
| Measured, cached | 2.9 ms  | 2.9 ms  |

Tokenizing 20,000 characters during a real generation took 4.7 ms at p50 and 5.9 ms at worst across 16 samples.

## Known limits

- **First turn:** a compile never loads a model to count with it, so the first turn after a model loads uses the estimate, and records `model-not-loaded`.
- **System message only:** history compaction and `reportContextDispatch` still use the estimate, so the whole request is not exactly measured.
- **One oversized unbroken line** is dropped rather than cut, as before, because `fitAtBoundary` never cuts inside a word. Measured packing does not change that, and it matters most for minified JSON.
- **Worker path:** the live run was in process. The worker's handler and its RPC were not run in a packaged utility process, so their latency is unmeasured.
- **Question corpus:** the issue's corpus was not run. These figures use repository files and generated dense text.

Verification: `npx vitest run tests/native-token-count.test.ts`, plus the live run above, which is not a committed test because it needs a local model.
