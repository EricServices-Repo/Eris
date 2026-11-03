# #151 — Scoped context handles for specialist agents

A delegated specialist (inline `delegate`) or background child carries a host-sealed
`contextOrigin` bound to its own execution root (#263), but the agent loop used that
origin only when the run also had a `conversationSource`, which only the foreground
chat sets. Children therefore had no thread recall at all: `context_search` with
`scope: "thread"` answered "Conversation history is not available to this task", and
a parent's older constraint could reach a child only through the handoff prose.

`taskThreadRecall()` (in `agent/context-pull.ts`) now picks the conversation a task may
pull from:

- **With an origin:** `originThreadRecall`, bound to the child's task, thread and
  execution root. Every search and read re-resolves the origin before and after the
  read: seal, profile, thread, source registration, controls epoch and the
  destination's disclosure rule. Nothing from the parent is copied into the child.
- **Without an origin:** the run's own conversation, as before.
- **Neither:** no thread recall.

The handle is evidence only. The child keeps its own intersected authority, can reach
only the sealed thread, and a revoke, forget or disclosure change after delegation
stops further reads.

A refused handle (changed controls, wrong thread, disallowed disclosure) used to throw
out of `context_search` and `context_read`, which have no local error handling in the
loop. It now returns `ok: false` with `Conversation history was refused (<reason>)`,
so the model can continue. Cancellation still propagates. A `scope: "all"` search
keeps its run-journal hits and adds the refusal as a note.

## Not done

- No per-assignment allowlist of source IDs. A child can search the whole sealed
  parent thread (within scope and controls), not only the sources its assignment
  needs. The issue's "bounded assignment-relevant handles" with permitted ranges/IDs
  is still open.
- Typed partial outcomes and model-switch tests for failed/stopped specialist work
  are covered by #264/#298, not changed here.
- No live-model run: a real specialist was not observed choosing to search.
