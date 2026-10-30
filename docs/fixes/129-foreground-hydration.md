# #129 — foreground hydration admission

A bounded scheduler owns the entire header/control/page hydration transaction. Two active streams and eight queued tasks are allowed. At most one stream is speculative, reserving capacity for foreground chat and inspector requests. Same-thread consumers still coalesce; foreground consumers promote queued/background work. Equal-priority namespaces rotate, and saturated foreground requests displace a queued speculative task. Excess speculative opens are rejected without posting worker RPCs.

Queued cancellation removes work; active cancellation keeps its reservation until the outstanding RPC settles. Existing SharedHydration consumer isolation and the foreground recall deadline remain in force. Pages are still posted one at a time with cooperative yields. This bounds stream admission, not total SQLite/native allocator bytes; transient allocation accounting is tracked separately in #131.

Validation: `npx vitest run tests/context-memory-recovery.test.ts` tests saturation, promotion, namespace fairness, cancellation, active slot ownership and actual foreground recall while speculative work is held. Deterministic scheduler/SQLite fixtures, no live providers.
