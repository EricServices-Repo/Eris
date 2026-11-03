# #234 — Embedding gain on the paraphrase benchmark

The first #234 change (`234-paraphrase-recall-measurement.md`) showed that lexical
recall misses 8 of 22 paraphrases at recall@5. This one measures what a small CPU
embedding model recovers on the same threads, and how its results can be merged into
the lexical ranking. It changes no Eris behaviour: nothing in the product embeds yet.

## Method

`checks/embedding-recall.ts` runs each benchmark case (source, distractor, 40 noise
messages) through four rankings:

| Ranking | What it is |
|---|---|
| lexical | production `ContextMemoryStore.select`, unchanged |
| embedding | every message by cosine similarity to the query |
| hybrid (RRF) | lexical and embedding merged by reciprocal rank fusion, k = 60 |
| best rank | each message's best rank in either list; ties go to the better other rank |

Vectors carry an `EmbeddingSpace` (model file + digest, dimension, prefixes).
`rankByEmbedding` refuses to compare vectors from different spaces or dimensions.

`scripts/measure-embedding-recall.mjs` loads a GGUF embedding model with
`getLlama({ gpu: false })` and `gpuLayers: 0`, so it runs on CPU only.

```
npx vite build --config checks/vite.performance-node.config.ts
node scripts/measure-embedding-recall.mjs --model bge-small-en-v1.5-q8_0.gguf \
  --query-prefix "Represent this sentence for searching relevant passages: "
node scripts/measure-embedding-recall.mjs --model nomic-embed-text-v1.5.Q8_0.gguf \
  --query-prefix "search_query: " --doc-prefix "search_document: "
```

Raw reports, with model digests and sources: `checks/performance/observations/embedding-recall-m4.json`.

## Result: Apple M4, 16 GB, CPU only, node-llama-cpp 3.22.1, `main` 226123a

Paraphrases only (22 cases); recall@1 / @3 / @5. All six lexical controls are rank 1
in every ranking.

| Model (size) | lexical | embedding | hybrid (RRF) | best rank |
|---|---|---|---|---|
| bge-small-en-v1.5 Q8_0 (37 MB, 384-d) | 0.32 / 0.64 / 0.64 | **0.73 / 0.95 / 0.95** | 0.36 / 0.64 / 0.64 | 0.36 / **0.91 / 0.95** |
| nomic-embed-text-v1.5 Q8_0 (146 MB, 768-d) | 0.32 / 0.64 / 0.64 | 0.77 / 0.82 / 0.86 | 0.36 / 0.59 / 0.59 | 0.36 / 0.86 / 0.86 |

By category (bge-small, recall@3): synonym 0.43 → 0.86 embedding / 0.71 best rank;
description 0.40 → 1.00 / 1.00; abbreviation 0.80 → 1.00 / 1.00; inflection
unchanged at 1.00.

Latency per text on CPU: bge-small 1.5 ms p50 / 2.3 ms p95 for a query,
1.0 / 1.3 ms for a stored message. nomic: 6.1 / 7.2 ms and 5.4 / 7.0 ms.

## Reading it

1. **The gain is material.** The smaller model lifts paraphrase recall@5 from
   0.64 to 0.95. Only `syn-crash` ("the app fell over" for a segfault) is still missed.
   `desc-login-thing`, the issue's own example, goes from not recalled to rank 2
   (embedding) or 3 (best rank).
2. **The merge rule decides whether any of it reaches the prompt.** Plain RRF gives
   anything both lists returned a higher score than anything only one list returned.
   Lexical recall always returns its distractor, so a source only embeddings found
   ranks behind it. RRF therefore recovers **none** of the lexical misses. Best rank
   recovers all but one at recall@5.
3. **Best rank does not fix rank 1.** The lexical first hit is usually the distractor
   that repeats a query word; it ties with the embedding's first hit and wins the
   tie. Embedding alone has recall@1 0.73; best rank stays at 0.36.
4. **Query embedding is cheap enough for a send-time deadline.** About 2 ms on CPU
   for bge-small, far below the 2 s pull deadline. Indexing a 1,000-message thread is
   about a second of CPU.
5. **Bigger is not better here.** nomic is 4× larger and 4× slower, and scores lower
   at recall@3 on this set.

## Limits

- Synthetic, hand-labelled and small (22 paraphrases, 40 noise rows each). It shows
  the size of the gain, not a calibrated estimate for real threads.
- One host (unified memory). "No VRAM used" is by construction (`gpu: false`), not
  verified on a dedicated-GPU host as acceptance requires.
- Run under Node, not in a separate Eris process, and nothing is indexed durably.
- `context_search` reformulation by a real model (#223) was not paired with this.
- bge-small logs a tokenizer round-trip warning from node-llama-cpp; results were
  still as above.

## What this means for #234

The acceptance item "the benchmark shows a material gain before enabling this by
default" now has evidence for a small CPU model, **provided** the merge lets an
embedding-only hit compete on its own rank. An implementation should not use plain
RRF over the current lexical list. The remaining required changes (separate process,
durable namespaced vectors, idle indexing, forget propagation, §12.9 amendment) are
not started.

## Tests

`tests/embedding-recall.test.ts` (classified in `agents`) uses a deterministic oracle
embedder:

- without a model, every merged ranking equals the lexical one
- vectors from another model or dimension are refused
- the fusion finding: best rank reaches recall@3 = 1 with a perfect embedder, while RRF
  still misses every source lexical recall missed
