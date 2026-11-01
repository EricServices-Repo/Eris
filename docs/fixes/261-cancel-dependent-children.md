# #261 — Stop dependent children before discarding a parent's worktree

Stacked on #255, because both change the line that launches a job.

`stopBackgroundJob` stopped only the job it was given, and `discardBackgroundJob` called it and removed the worktree straight away. A child sharing that worktree kept generating and writing, and the directory could vanish under it.

- **Stop covers the subtree.** Every descendant is dependent, because nothing creates a detached child today. Running jobs are aborted and queued jobs become `stopped`, so they never start. Other job trees are untouched.
- **No new children under a stopping job.** Enqueue refuses, and the delegate tool returns that to the agent.
- **Discard waits for real completion.** The pump keeps each job's finish promise, which settles after its ledger flush and cleanup, and discard removes nothing until the tree has finished.
- **Timeouts keep the worktree.** After 30 seconds the job is left as it is with `worktreeRetained` and a status saying so. Discarding again retries.
- **The worktree path is read after the wait,** so a job that was still planning cannot leave a directory behind. A job stopped during planning now creates no worktree at all.
- **Children sharing the removed worktree** are marked discarded with their parent. A child with its own worktree stays `stopped` with its work intact for review.
- **Discard is idempotent.** Overlapping calls join one operation and a repeat returns the result, so a worktree goes once.
- **Merge** refuses while a descendant is still running, because merging also removes the worktree.

## Known limits

- **Agents that ignore abort:** a stopped job can only finish at its next abort check. A long tool call can hold the discard until the timeout, which is when the worktree is kept. Nothing force-kills it.
- **Native sessions and leases** release through the existing `finally` paths, which the wait covers. The tests use a fake runner, so real native sessions were not exercised.
- **No detached children:** if that concept is added later, the traversal will need to skip them.
- **A timed-out discard does not retry on its own.** Someone has to discard again.
- **UI:** `worktreeRetained` reaches the job's status line. No dedicated control or view was added, and the Agents panel was not viewed in the running app.

Scripted only, with a fake runner and a stubbed worktree remover. No real worktree was removed and no packaged run was done.

Verification: `npx vitest run tests/background-cancellation.test.ts`.
