# #234 — Paraphrase recall measurement (RAM-CTX-062 gate)

§12.9 allows embeddings only after a lexical benchmark shows material paraphrase
misses. This is that benchmark and its first result. It does **not** add embeddings.

## What it measures

`checks/paraphrase-recall.ts` plants one source message, one distractor that shares
surface words with the query, and 40 noise messages in a thread, then runs the
production `ContextMemoryStore.select` ranking for a later query. It reports the
1-based rank of the source among recalled (non-pinned) facts and recall@1/3/5 per
category. No model, embedding or provider call is involved.

28 hand-labelled cases: 6 lexical controls that reuse the source's key terms, and 22
paraphrases in four categories (synonym, abbreviation, inflection, description).

## Result (ranking version 2, `main` 9afe507, 2026-11-02)

| Category            |  Cases | recall@1 | recall@3 | recall@5 | Misses                                      |
| ------------------- | -----: | -------: | -------: | -------: | ------------------------------------------- |
| lexical-control     |      6 |     1.00 |     1.00 |     1.00 | —                                           |
| synonym             |      7 |     0.29 |     0.43 |     0.43 | syn-login, syn-money, syn-crash, syn-cheap  |
| abbreviation        |      5 |     0.40 |     0.80 |     0.80 | abbr-k8s                                    |
| inflection          |      5 |     0.40 |     1.00 |     1.00 | —                                           |
| description         |      5 |     0.20 |     0.40 |     0.40 | desc-login-thing, desc-rounding, desc-flake |
| **all paraphrases** | **22** | **0.32** | **0.64** | **0.64** | 8                                           |

The issue's own example, "the login thing" for an OAuth callback handler, is not
recalled at all, and a distractor that shares a word ("earlier") ranks first.

Reproduce: `npx vitest run tests/paraphrase-recall.test.ts` (asserts the miss set
above for ranking version 2), or call `measureParaphraseRecall()`.

## Reading it

- **The gap is material for synonyms and descriptions** (≤ 0.43 recall@5). These
  share no content words with the source, so no lexical change fixes them.
- **Inflection and most abbreviations already reach recall@3.** They lose rank 1 to
  a distractor that repeats a query word verbatim. The remaining abbreviation miss
  (`k8s` → Kubernetes) is fixable with a small alias table, without embeddings.
- **At least one "synonym" hit is lexical by accident:** `syn-forbid` shares
  "release" with its source. A strictly synonym-only score would be lower than 0.43.

## Limits of this evidence

- Synthetic, hand-labelled and small (22 paraphrases). It shows a gap exists; it is
  not a calibrated estimate of how often real users paraphrase.
- Single-source threads. Longer threads with many near matches may rank worse.
- `context_search` (#223) lets a model reformulate a query; this measures push recall
  only. The issue says to evaluate after #223 because model-driven search may close
  part of this gap. That paired measurement (with a real model) is not done here.
- No embedding was evaluated, so no quality gain is claimed. Acceptance item
  "material gain before enabling by default" is still open.
