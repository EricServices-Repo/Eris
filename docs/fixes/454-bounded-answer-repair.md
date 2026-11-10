# #454 — Bound answer repair and preserve evidence-specific truth

`finalizeAnswer` repairs protocol-leaking, evasive, refused or truncated answers by calling the
model again. Three problems:

1. **Ungrounded repair.** Every re-answer used an instruction that allowed "state your assumption
   and give general guidance", including for project work whose answer depends on sources.
2. **Repairs could claim new work.** A re-answer after an edit could say it changed files the task
   never touched, and nothing checked it.
3. **Unbounded calls.** Protocol re-answer, creative/evasion re-answer and code continuation could
   chain to three extra model calls for one answer.

**Change.**
- Source-required tasks (`evidenceRequirementFor(...) === 'required'`, or sources were read) use a
  grounded re-answer instruction: only provided sources and established facts; otherwise say
  *not yet verified*. Generic chat keeps the previous instruction.
- The loop passes `changedFiles` (the run's touched files); files changed by the turn this task
  continues (`task.continuation.changedFiles`) also count, so "what did you change?" can report them. The repair prompt lists them, and
  `unbackedEditClaims` rejects a repair that names a changed file outside that list, or for
  project work with no changes, makes any first-person change claim. A rejected repair leaves the
  answer partial (`incomplete: true`), never presented as done.
- `MAX_REPAIR_CALLS = 2` caps extra model calls; exceeding it returns the draft as incomplete.
  Repairs still run under the run deadline's signal.
- The presentation audit now records every repair attempt (`kind`, `accepted`, `digest`,
  `reason`) separately from the raw model output.

Tests: `tests/bounded-answer-repair.test.ts` (the call-cap test makes three calls without the cap).

**Not changed:** the edit-claim check is text-level and only catches first-person past-tense
claims; unresolved-obligation tracking is not part of this change.
