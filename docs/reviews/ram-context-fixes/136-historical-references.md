# RAM-CTX-026: historical recommendation binding

## Ownership and intake

Task result persistence records an atomic, profile/workspace/thread-scoped recommendation catalog. It stores source message IDs, project scopes, stable recommendation IDs and SHA-256 item digests; answer text remains owned by canonical SQLite. Root aliases canonicalize to the same namespace. At most 64 advice batches / 512 KiB of metadata are retained. This is a bounded artifact index, not a claim that every old transcript passage is searchable; general cold-history retrieval remains a separate capability.

The shared production/diagnostic turn-contract boundary resolves historical references before constructing the task contract. Explicit IDs select exactly those current eligible items, including batches outside recent chat history. Multiple eligible batches make an ordinal such as “the second one” ambiguous. The contract carries a clarification criterion and no tool/edit/execute authority in that case. Clarification exposes a bounded list of source/item IDs, rather than guessing a batch. Unknown, expired or unavailable references fail closed; legacy turns without catalog metadata retain their existing recent-history path.

An approved reference remains evidence. The latest request, Ask mode, explicit effect constraints and selected project determine authority. Bound sources narrow project scope; they do not import old permissions. Diagnostics may supply the same typed reference result explicitly to keep independent case namespaces isolated. Exports recognize the `historical-artifact` source label.

## Canonical freshness and destinations

A worker uses the existing indexed message-ID lookup to materialize only catalogued assistant sources. Each lookup runs in a SQLite snapshot, applies current forgotten IDs and sequence/ordinal cutoffs, matches project scope, and re-extracts stable items to verify their digests. It reads no intervening transcript. Per-source content is limited to 65,536 characters; total returned source metadata/items are capped at 1 MiB. Oversized/unindexed/rewritten/deleted sources cannot silently authorize another item. The response carries the canonical revision, source epoch and controls revision.

References outside the recent canonical history respect disabled recall and the remote-history disclosure ceiling. Bound tasks record whether the source was recent, explicitly opted in for remote recall, or local-only. Generation, direct-provider diagnostics, outcome review, model compaction, normal tool execution and automatic verification recheck eligibility/destination. Later opt-out, exclusion, deletion or scope changes stop reuse. A disallowed compaction model uses the local deterministic summary fallback. Canonical lookups have the foreground recall deadline. Child tasks inherit the binding and must retain a valid source namespace/scope; unavailable cross-worktree sources fail closed rather than importing another thread's task.

## Verification and limits

Deterministic regressions cover a reference more than 1,000 messages back, exact IDs, ambiguity, unknown IDs, Ask mode, project isolation, deleted/rewritten/excluded sources, disabled recall, remote opt-out, recovery/compaction/outcome models and bounded metadata. The shared production turn-contract function is exercised directly and its contracts checked for authority conflicts. These fixtures make no live-model success or packaged-platform claim. The canonical source is revalidated at admission boundaries; this is not a distributed transaction locking external filesystem edits together with SQLite.
