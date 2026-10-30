# #127 — immutable recall policy and namespace capacity

Foreground recall captures validated enabled/disclosure/prompt policy before its first await. Store selection copies it before cooperative scanning. The facade no longer reapplies workspace policy to the process singleton. Only profile settings configure the allocator; workspace max-message/thread retention remains namespace-scoped and cannot increase the profile limits. Workspace disable clears only its own namespace. Source/control mutation and real allocator changes retain generation fences; disclosure/prompt/deadline changes do not invalidate unrelated source snapshots.

The namespace capacity registry is bounded to 256 keys; eviction clears the affected namespace. Opposing workspace policies retain independent prompt limits and disclosure flags during concurrent scans. Policy changes do not revoke requests already sent; dispatch-time revocation remains #125.

Validation: `npx vitest run tests/context-memory.test.ts tests/context-memory-recovery.test.ts`. Includes opposing policy concurrency, caller mutation, independent disable and existing expansion/cancellation/privacy regressions. No live inference or hardware measurements.

Registry rollover also evicts only cold-key generation leases and assigns fresh monotonic leases on reacquisition, avoiding both ABA installation and process-wide epoch resets. A 1,000-namespace stress fixture keeps a warm selection coherent while rejecting an old evicted cold lease.
