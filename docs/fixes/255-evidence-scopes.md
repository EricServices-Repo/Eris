# #255 — Scope recall evidence to the request that took it

Evidence leases sat in one process-wide Set, and `withEligibleMemory` applied every lease to every outbound request. Once request A had exposed local-only recall, an unrelated remote request B lost its own user message and received A's intent, or threw on a different-task bundle.

- **Scope:** `AsyncLocalStorage` now carries an evidence scope. Each chat request gets its own, and a lease belongs to the scope that took it.
- **Ownership:** a lease applies in full, including derived-text withholding, only to its own scope or to a message whose bundle names its task. Derived text inside a request is treated exactly as before.
- **Recalled items are stripped everywhere:** if a message in another scope carries a lease's item marker, that item is still removed. Only the item goes. Another lease's intent and authority never replace a message, including when two requests recall the same item.
- **Background jobs:** a delegated job keeps the scope of the request that delegated it, so a child still answers to its parent's recall while the parent lives. Every other job gets a fresh scope, because the queue pump can run inside any request's async context. The scope is passed in before the pump starts, since the pump can launch a job before enqueue returns.

## Known limits

- **Lost scope:** a dependent call that lost its scope would still have recalled items stripped, but text merely derived from them has no marker, so it would not be withheld. Any async work must stay in the request's context, and the tests cover streams and child jobs.
- **Parent has ended:** a child outliving its parent's lease has no protection. That is #256, and this change does not make it worse.
- **After a restart** the in-memory scope is gone, so a resumed child starts in a fresh scope. That is also #256.
- **Same thread, same item:** two requests sharing an item each keep their own lease, and a revocation applies to both through the shared source state.

Scripted only. No live provider call or packaged run.

Verification: `npx vitest run tests/memory-dispatch.test.ts tests/background-evidence-scope.test.ts tests/derived-privacy-lineage.test.ts`.
