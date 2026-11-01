# Amendment 001: tiered VRAM and RAM memory

- Amendment ID: ERIS-CONTEXT-002-A1
- Amends: [ERIS-CONTEXT-002](RAM-CONTEXT-ARCHITECTURE.md)
- Status: accepted target design; **not a claim that the target is built**
- Date: 2026-10-31
- Reviewed implementation: `842bde276230dfc91f3c6e16b56fbb7a91fa9bf2` (v0.6.7)
- Tracking issue: #239

Where this amendment and ERIS-CONTEXT-002 disagree, this amendment wins. Numbers marked *proposed* are starting points to benchmark, not measurements. [CONTEXT-MEMORY.md](CONTEXT-MEMORY.md) remains the record of what is implemented.

## A1. Goal

Run the model on VRAM and keep context in RAM, so the model can pull what it needs and compaction stops losing information.

## A2. Tiers

| Tier | Holds | Role |
| --- | --- | --- |
| VRAM | Model weights and the active context window | What the model sees now |
| RAM | Run journal, warm thread history and indexes | Fast, recoverable working memory |
| SQLite | Canonical transcript, durable journal and archive index | Source of truth |

Text moves from RAM into VRAM only through a compiled prompt. Nothing else places context in front of the model. SQLite stays canonical, so losing the RAM tier costs speed and recall, never history.

## A3. The hard limit

**A model can only use what is in its context window. RAM does not enlarge that window.**

RAM makes content retrievable, not simultaneously visible. "Lossless" in this amendment means every evicted item can be recovered by reference. It does not mean everything is in the prompt at once. Claims, UI text and release notes must not say or imply that a larger RAM tier gives a model a larger window.

## A4. Unified memory

On unified memory, including Apple Silicon, RAM and VRAM are one physical pool. The tiers there are budgets on shared hardware: every byte given to the RAM tier is a byte the model and its KV cannot use. The model comes first.

With a dedicated GPU the two are separate hardware, so a larger RAM tier takes nothing from the model.

Host class therefore changes sizing policy (A8), and release evidence must record it (A10).

## A5. Compaction

Eviction with handles is the default compaction. This replaces the separation in CONTEXT-MEMORY.md, where run-local compaction is unrelated to RAM memory.

1. A tool result is written to the run journal before it enters the message array.
2. Eviction replaces content in the prompt with a stub that holds a reference and a short description.
3. The default path makes no model call.
4. A summary is optional. It must cite references, and it is never the only copy of evidence.
5. If an entry is unavailable, compaction falls back and records it. It must not emit a stub that points to nothing.

## A6. Pull

The model can retrieve from RAM on request, through tools that return bounded spans.

Pull follows the same policy as push: exclusions, cutoffs, project scope, evidence revalidation, secret filtering and destination policy. Pulled content is historical evidence, labelled as such, and it can never change task authority, scope or approvals. A remote destination receives nothing unless `shareWithRemoteModels` allows it.

Pull may use a longer deadline than the send path, because the model is already waiting on a tool. Results stay capped per call and per run against the input budget.

## A7. Destinations and windows

These extend §15.3.

- Dispatch classifies each destination as `in-process`, `loopback` or `remote`, from the resolved connection URL. A name or provider label is never trusted.
- Loopback destinations receive recall by default. LAN hosts are remote unless the user approves them per connection.
- Budgets use the window the runtime allocated, with provenance. An unverifiable local server gets an explicit conservative window.
- VRAM placement prefers a smaller window over spilling layers to CPU, because a smaller window with RAM paging beats a larger one with CPU layers.

## A8. Revised limits

| Spec section | Previous position | Amended position |
| --- | --- | --- |
| §7.2 | 512 MiB maximum automatic ceiling | Dedicated GPU: up to 25% of available host RAM, ceiling about 8 GiB (*proposed*). Unified memory: 128 MiB to 2 GiB of what remains after the model, weights and KV (*proposed*). |
| §7.2 | Lower of cap, profile and safe headroom | Unchanged. No minimum is imposed when safe headroom is zero. |
| §14.3 | Fixed recall and history constants | One allocation scaled to the input window, starting from the §14.3 15% recall experiment (*proposed*). |
| §2.2, §12.9 | No embedding model on message arrival; no embedding generation on send | A small embedding model may run CPU-only, in a separate process, after measured gain. Query embedding on send is allowed under the send deadline and falls back to lexical results. It must never use the GPU or swap the text model. Indexing stays in admitted idle time. |
| §15.4 | Cross-turn KV reuse is optional | KV reuse is a target once the prompt prefix is stable. The prefix is ordered by volatility, and the cache identity rules in §15.4 still apply. Parked KV state is conversation data and inherits deletion and forget rules. |
| §8.2 | Immutable segments in the existing store | Text lives in off-heap segments in a dedicated memory process, because a multi-GiB tier cannot live on the main-process heap. |

The §2.2 non-goal against keeping every source file, image or KV entry resident still stands, as does INV-14: deterministic context maintenance uses no GPU and does not swap the active text model.

## A9. Invariants

**INV-15 — Recoverable eviction:** no tool result is evicted without a recoverable handle or an explicit omission marker. A missing entry must never read as "no such output".

**INV-16 — Window honesty:** budgets, diagnostics and UI state which window they use and how it is known. A planned or unverified window is never reported as measured.

**INV-17 — Pull parity:** content the push path may not send is not returned by the pull path.

INV-01 through INV-14 are unchanged. References to "INV-01 through INV-14" in §25 now include these.

## A10. Evidence

Each gate has a threshold in release evidence, and regressions in store wipes or recoverability block a release. Hardware results record host class, with at least one unified and one dedicated host. Scripted passes are never reported as live-model or hardware passes.

## A11. Traceability

| Review ID | Issue | Section |
| --- | --- | --- |
| RAM-CTX-043 | #215 | A10, §7.4 |
| RAM-CTX-044 | #216 | A10, §7.4 |
| RAM-CTX-045 | #217 | A2, §22 |
| RAM-CTX-046 | #218 | A7, INV-16 |
| RAM-CTX-047 | #219 | A7 |
| RAM-CTX-048 | #220 | A7, INV-16 |
| RAM-CTX-049 | #221 | A5, INV-15 |
| RAM-CTX-050 | #222 | A5, INV-15 |
| RAM-CTX-051 | #223 | A6, INV-17 |
| RAM-CTX-052 | #224 | A5 |
| RAM-CTX-053 | #225 | A2, A5 |
| RAM-CTX-054 | #226 | A8 |
| RAM-CTX-055 | #227 | A4, A8 |
| RAM-CTX-056 | #228 | A8 |
| RAM-CTX-057 | #229 | A7, §14.2 |
| RAM-CTX-058 | #230 | A7 |
| RAM-CTX-059 | #231 | A4 |
| RAM-CTX-060 | #232 | A8 |
| RAM-CTX-061 | #233 | A8 |
| RAM-CTX-062 | #234 | A8 |
| RAM-CTX-063 | #235 | A6, §12 |
| RAM-CTX-064 | #236 | A3, A4, INV-16 |
| RAM-CTX-065 | #237 | A10 |
| RAM-CTX-066 | #238 | This amendment |
