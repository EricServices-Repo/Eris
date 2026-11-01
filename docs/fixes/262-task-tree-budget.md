# #262 — Bound delegation across a whole task tree

Each background child got a fresh step limit, and a parent waiting on children gave up its scheduler slot, so concurrency limits did not bound the tree. An agent delegating the same goal to itself could keep going.

Every job now belongs to a tree started by its root, and these limits apply to the whole tree:

| Limit | Value | When reached |
| --- | --- | --- |
| Depth | 4 levels | The delegation is refused |
| Cycle | Same agent and goal as an ancestor | The delegation is refused |
| Agents | 16 | The delegation is refused |
| Model steps | 600 | Running jobs stop, queued jobs fail, delegation is refused |
| Time | 60 minutes from the root | Same as steps, and a timer covers an agent that is only waiting |

The refusal reaches the coordinator as a tool result saying which limit was hit and to finish what it can. The job records `budgetExhausted`. The detail view shows tree usage separately from the job's own steps, for example `task tree: depth 1/4 · 2/16 agents · 40/600 steps`.

**The reservation is the job record.** Usage is read from the jobs, not from a counter, and the check and the insert happen in one synchronous pass. So there is nothing to leak or to reset on restart. A job that never ran stops counting when it ends, which is what releases its slot on cancellation or restart. A job that ran keeps counting, however it ended.

## Decisions to review

- **The limits are constants** in `TASK_TREE_LIMITS`, not settings. They are generous for one request and easy to promote if they prove wrong.
- **A cycle needs the same agent and goal.** One agent passing its goal to a different agent is an ordinary handoff, and equal goals on siblings are allowed. A cycle that rewords the goal each time is stopped by depth instead.
- **`tests/background-cancellation.test.ts` changed.** It created a grandchild with its parent's exact agent and goal, which is now a cycle, so it uses a distinct goal.

## Known limits

- **Chat delegations are separate roots.** A chat coordinator has no job, so each child it starts gets its own tree. The chat run's own step limit bounds how many it can start.
- **Steps are counted as agents report them.** A job stops at its next progress event or abort check, so a tree can overrun by what is already in flight. Token use is not budgeted.
- **The step limit is not reserved per child.** Agents draw from a shared total, so the first ones can use it up.
- **Jobs are never pruned**, so a tree's usage reads every job in the file on each update. That is small today.
- **No restart resumes a job**, so the restart tests load saved files and delegate from them. A real application restart was not run.

Scripted only, with a deterministic fake agent. No recursive live workload was run.

Verification: `npx vitest run tests/task-tree-budget.test.ts tests/background-cancellation.test.ts`.
