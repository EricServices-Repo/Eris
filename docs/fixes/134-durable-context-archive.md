# Issue 134: implementation and acceptance notes


### RAM-CTX-024: bounded durable archive recall
Worker-owned SQLite chunk/posting tables keep evicted sources searchable. A portable lexical posting backend is used on both FTS5-enabled and FTS5-unavailable builds; the runtime capability is exported rather than assuming packaged SQLite supports a particular tokenizer. Each probe advances at most 32 overlapping 2,048-codepoint chunks, persists ordinal/content cursors, considers at most 4,096 postings/64 candidates and returns at most twelve source excerpts. Controls and registered task scope filter canonical materialization, and canonical text/sequence must still match the indexed span. Write/delete triggers invalidate affected chunks; restart resumes bounded indexing. An incomplete cursor explicitly means partial coverage, not a claim of whole-archive recall.

When admitted RAM coverage is partial, production recall probes the archive after the normal warm path. It merges only missing sources under the existing evidence token budget. Temporary selection has a 12 MB envelope plus a 4 MB transfer reservation against the global owner; it does not consume a warm-conversation slot. Memory disclosure, canonical header checks, source epochs, and the existing dispatch lease still apply. A rewrite during an active lease may conservatively withhold an archive source absent from the warm cache. Index failures and deadline exhaustion preserve canonical recent-history fallback.

Each of at most sixteen query terms receives its own newest 256-posting slice before global ranking. Common words cannot consume the arena before a rare identifier participates; the total remains at most 4,096 posting visits.
