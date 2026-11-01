# #258 — Protect required handoff constraints

Stacked on #257, which added the `inherited` record this extends.

A handoff was one block of text. Inline delegation sent it as a system message, which became optional project evidence that the compiler could cut. Background delegation put the same text in the user message, so the two modes differed in role and retention. A constraint at the end of a crowded briefing was lost with nothing said.

- **Typed constraints:** `delegate_to_agent` takes `constraints`, at most 12 and 300 characters each. They go into `inherited.constraints`, which is part of the required task block.
- **Refused, not shortened:** too many, including inherited ones, or one too long, is returned to the coordinator as a tool error. A job that reaches the limit some other way fails rather than dropping any.
- **Blocked before inference:** the task block is required, so the existing compiler error stops a run whose constraints cannot fit.
- **One shape:** `handoffMessages()` gives both modes the same system briefing and user goal. The goal, parent request and constraints live in the contract, so the briefing no longer repeats them.
- **Optional evidence:** the summary, files and open questions can still be cut, and the compiler's manifest records omitted characters and digests with no text.

`formatHandoffForPrompt()` still renders the whole packet, for routing and for showing a job's result in chat.

Coordinator guidance now says to put anything that must hold in `constraints`.

## Known limits

- **Coordinators must use the field.** A constraint written only in `summary` can still be cut. The model is told not to do this, but nothing detects it. Requirements in the user's own request are covered by #257 regardless.
- **No handoff source IDs exist yet.** The issue asks for admitted and omitted source IDs. Handoffs have no such IDs, so the project block's manifest is the record, at block level. Per-source tracking needs the versioned envelope in #256.
- **Live behaviour:** whether a real model fills in `constraints` well is unmeasured.

Scripted only. No live model run.

Verification: `npx vitest run tests/handoff-constraints.test.ts tests/agent-conversation.test.ts tests/agent-orchestration.test.ts`.
