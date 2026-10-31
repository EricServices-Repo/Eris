# Issue 132: implementation and acceptance notes


### RAM-CTX-022: incremental recent projection and cooperative installation
Canonical detailed history and UTF-8 chunk decoding remain worker-owned in SQLite; main retains only its admitted bounded evidence projection. Recent rows and lexical postings use immutable 128-row blocks. Uncontended appends touch only new records and bounded blocks, maintain byte/source/ordinal counters incrementally, and prune retired postings without shifting whole arrays. Overlap validation is indexed; chunked sources still invalidate and reload from canonical worker chunks. Active selections retain their immutable ring snapshot; only a pinned ring needs a block-reference fork, charged by the existing snapshot ledger. This exceptional concurrent path is not advertised as constant cost.

Hydration collects ordered worker segments without repeatedly prepending the accumulated transcript. Production installation skips whole-history sorting and yields every 64 normalized/indexed rows, publishing once only if its lease remains valid. Legacy synchronous installation remains for deterministic fixtures. These are structural bounds and scripted validation, not certified absolute main-thread latency on every host. SQLite persistence ordering and source/controls/revision fencing remain authoritative.

Overlap comparison normalizes both canonical and live metadata using the same schema, so JSON property order cannot invalidate an unchanged warm snapshot.
