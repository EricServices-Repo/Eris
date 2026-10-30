# #137 — source-backed unfinished task state

Each persisted assistant reply can carry a versioned ThreadWorkingState with task ID/revision, source message ID and project root. A bounded runtime builder consumes actual diffs, command/verify tool outcomes and question replies in both local and cloud runs. It records observed effect IDs, verification digests, pending obligations, selected recommendation IDs and unanswered questions. Narrative answers and progress summaries never close work or change a check result. A different command cannot supersede a failed check; a later file mutation makes prior passes stale.

The source projection survives canonical SQLite/recovery normalization. Its terms participate in recall even if the visible answer merely says done. Recall includes a compact typed working-state view with explicit omissions; effects remain historical and must be revalidated before being repeated. Source/task identity must match the enclosing receipt. Obligations without explicit effect attribution remain pending, and effect-observed is deliberately separate from completed/verified. Older receipts retain their conservative historical rendering.

The projection is rebuilt from retained runtime evidence and persisted with the reply before terminal delivery. It does not infer arbitrary per-obligation success from file counts, parse assistant prose as evidence, or automatically execute a resume. Source deletion/rewrites remove the containing canonical record through existing fencing.

Validation: `npx vitest run tests/thread-working-state.test.ts tests/chat-stream.test.ts tests/context-memory.test.ts`: stopped tasks, confirmed diffs, failed/mismatched checks, stale passes, unanswered questions, normalization and retrieval beyond the recent window. No live model or packaged UI behavior is inferred.

Explicit resume/continue/remaining queries also use the existing bounded salient-row lane for unfinished task projections. A buried stopped task therefore remains discoverable without the user repeating its old filenames or test command. Generic questions do not get that additional ranking bonus.
