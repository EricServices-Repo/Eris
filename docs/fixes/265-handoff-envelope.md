# #265 — One versioned contract for a handoff

A handoff was a TypeScript interface and nothing more: the tool's aliases were resolved by hand, the schema had no limits, and enqueue saved whatever arrived.

`parseHandoff` in `src/shared/agent-orchestration.ts` is now the one reading of a packet. It runs at the tool, at enqueue and when a saved job loads, so an inline and a queued specialist get the same packet. Parsing a parsed packet changes nothing.

| Input | Result |
| --- | --- |
| Blank goal, or one over 8,000 characters | Refused, with what to do instead |
| Confidence outside 0–1, or not a number | Refused |
| Constraints the limits cannot guarantee | Refused, by the existing rule |
| Disagreeing `agent_id`/`agentId` or `open_questions`/`openQuestions` | Refused at the tool |
| Summary or parent request over 16,000 characters | Cut with a marker, listed in `truncated` |
| More than 64 files or 16 open questions | Cut, listed in `truncated` |
| File lead that is absolute, climbs with `..`, or has control characters | Dropped, listed in `truncated`. A path inside the project is made relative first |
| Any field the parser does not name | Dropped, including on the task contract |
| Newer version | Refused |
| No version | Read as version 1 |

`truncated` reaches the specialist as an `Incomplete:` line in its briefing, so a cut is never silent. Required fields are refused instead of cut.

A saved job whose handoff cannot be read keeps its record and answer, loses the handoff and shows why in `error`. Queued and running jobs already become `stopped` on load, so nothing runs from a stale envelope.

## Decisions to review

- **Dropping a bad file lead instead of refusing the delegation.** A lead is a hint and the agent can still search, so a bad one should not cost the whole handoff.
- **Unknown task fields are dropped.** `TASK_FIELDS` is typed against `TaskContract`, so a new field fails the typecheck until it is listed.

## Known limits

- The parser checks a task's shape, not whether its authority is genuine. `enqueueBackgroundJob` is reachable from the renderer with a handoff, as it was before this change.
- `task.originalText` over the 256,000-character task limit refuses the delegation, because the contract cannot be cut safely.

Scripted only. No live model ran.

Verification: `npx vitest run tests/handoff-envelope.test.ts tests/agent-conversation.test.ts`.
