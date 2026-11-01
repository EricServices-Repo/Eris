# #256 — Revalidate a background handoff after its parent's lease ends

Stacked on #265, because the evidence travels in that envelope.

A coordinator's lease ends with its request. A queued child's handoff, written from what that coordinator had read, then matched no lease, so `withEligibleMemory` passed it through unchanged, to any model, however its sources had changed.

- **Capture.** `delegateFromAgent` records what the coordinator's model was shown, while the lease is alive. It keeps item ids, source ids, a digest of the text and the remote-sharing ceiling, and never the text. Only the runtime sets this: the tool cannot, and a request that never showed recall records nothing.
- **Child-owned hold.** `runWithHandoffEvidence` wraps each job in its own async context. It needs no parent lease and no process-wide entry, and it ends with the job on every exit. Jobs always state their own, so a job pumped from inside another cannot inherit it.
- **Check.** Every model call the job makes rechecks the canonical header, reloads the source if it changed, and compares each item by digest. It also checks sharing and destination approval, in the same tick as the lease checks. The job checks once before planning, so even the router never reads a handoff that fails.
- **Chains.** A child's own evidence passes to anything it delegates, so the first ceiling holds down a tree.

A later message in the thread does not invalidate a handoff. Only a change to an item it used does.

## Decisions to review

- **It refuses instead of rewriting.** Coordinator text has no sentence-level lineage, so the private part cannot be cut out of a goal or summary. The job fails with a reason, matching what `withoutDerived` already does for a task moved across a destination. Rebuilding the handoff automatically is not attempted.
- **A remote child under a local-only parent now fails** unless sharing is on or the endpoint is approved. Delegating to such a model while its parent was alive was already stopped by the lease, so this extends that to the queue. It is the behaviour most likely to surprise someone.
- **Sharing is sticky within a run.** Turning it off and on again does not restore a child's ceiling until the job is recreated, as with `lease.allowRemote`.

## Known limits

- **Digests of short excerpts can be guessed.** They keep private text out of the job file, but a very short excerpt could be confirmed by someone holding the file and guessing it. `background-jobs.json` already holds the derived summary itself, which is the larger exposure and is unchanged here.
- **Memory pressure fails closed.** Warming is skipped at critical pressure, so a child can fail with the "changed or removed" message although nothing changed.
- **`decision` and `task-result` items** follow the same rules as `ineligible` but have no dedicated test.
- **`background-jobs.json` queued jobs still become `stopped` on restart**, so no job resumes automatically today. The restart tests reload a saved packet and run it with no lease, which is what a future resume would do. A real application restart was not run.
- A child's result returning to the parent is #264's concern, and is not covered here.

Scripted only, through the real transport with a capturing provider. No real model or provider was called.

Verification: `npx vitest run tests/background-evidence-revalidation.test.ts tests/memory-dispatch.test.ts`.
