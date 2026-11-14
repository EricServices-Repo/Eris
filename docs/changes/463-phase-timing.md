# Task phase timing

The existing request-owned timeline records project retrieval, built-in verification, outcome review, and reply persistence as distinct phases alongside queue, routing, loading, prefill and generation. Durations are elapsed wall time between observed phase transitions, not CPU time or a causal attribution; concurrent work and approval waits can cross boundaries. A skipped stage has no fabricated duration.

These observations do not yet provide cold/warm model cohorts, p50/p95 reporting, paint timing, or hardware baselines. Outcome review includes transport and model loading within that review. Older task snapshots retain their original fields and may not contain the newer phases.
