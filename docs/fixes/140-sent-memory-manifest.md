# #140 — record which recalled facts were actually sent

`memory-selected` logged fact IDs before the compiler could shorten or omit the memory block, and `context-compiled` only had block-level sizes. Diagnostics could say a decision was selected when its text never left.

The compiler now emits a `ContextBundle`: each selected item with its source digest, ordinal, source span, line digest, characters sent, status (`sent`, `truncated`, `omitted`) and a specific reason. Items are placed against the characters of the memory block that survived, so an item cut in half reports how much of it was sent. A blocked remote destination keeps its items listed as `destination-policy` instead of dropping them from the report. The bundle also records the tokenizer method, which is still a character estimate rather than a backend tokenizer (#139).

The bundle travels on the compiled system message so it survives compaction and recovery. `streamProviderChat` removes it before serialization, so it never reaches a provider.

At dispatch, the context is compared with what actually leaves, after #125's eligibility check and after provider budgeting and protocol compilation. Each `context-dispatched` ledger event records the destination, model, the SHA-256 of the serialized request, and sent, truncated and omitted counts. Item detail is repeated only on a run's first dispatch and whenever a status changes, which keeps a long tool loop from growing the ledger. An item absent from the compiled text is `revoked-at-dispatch`, and one that was shortened later is `provider-budget`.

The manifest contains digests, ordinals, positions and counts only. Markers are rebuilt from logged fields, so reporting never has to retain source text.

Eris-Dev captures attach `dispatch` to each agent request next to `context`. The inspector shows a line for the conversation's latest actual request (model, local or remote, sent, shortened, left out), held for the 64 most recent namespaces in this session.

Limits:

- The inspector shows the last real request. A preview for a hypothetical query with the real scope and destination is #145.
- A live diagnostics run reports twice for one request, once as the adapter receives it (`adapted: false`) and once after provider adaptation (`adapted: true`). Simulated runs report only the first.
- A local GGUF session may reuse its seeded prompt, so `requestDigest` describes the request given to the session, not the tokens evaluated.
- Task-result lines and pins have no source span.

Depends on #125, which provides `MemoryPromptItem` and dispatch-time removal.

Validation: `npx vitest run tests/context-dispatch.test.ts`. Scripted provider capture with a stubbed transport, covering item mapping under a tight budget, truncation, destination switching, deterministic reports, dispatch revocation, provider shortening, absence of source text, and accounting never reaching the provider. No packaged, live-model or hardware run.
