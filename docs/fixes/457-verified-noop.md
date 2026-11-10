# #457 — Explain already-correct and intentionally unchanged outcomes

An edit request whose behavior already existed could only finish by editing something: the
pre-DONE gate (`shouldKeepWorking`), the goal check (`assessGoalCompletion`) and the outcome gate
(`evaluateOutcome`) all required a mutation. That pushes a model toward cosmetic changes.

**Change.** A separate result type, not a weaker edit gate:

- New tool `confirm_unchanged { requirement, path, evidence }` (read access).
  `agent/verified-noop.ts` accepts it only when the file was **fully** read in this task
  (`TaskToolGateway.fullReadRevision`), is unchanged since that read, and contains the quoted
  evidence verbatim (whitespace-normalized, at least 8 non-space characters). Otherwise the
  tool fails with a concrete reason.
- `AgentWorkflow` records `verifiedNoops` and reports `disposition: 'already-satisfied'` only when
  nothing was mutated. Named target files must each be confirmed. A later edit to a confirmed file
  drops its confirmation. Required code verification for named code targets is unchanged.
- `shouldKeepWorking` and `assessGoalCompletion` accept DONE without a mutation only with a
  verified no-op.
- The loop shows `Done · already satisfied — no files changed`, logs a `verified-noop` task event,
  and emits no diff. The system prompt tells the model to use the tool instead of a cosmetic edit.

Tests: `tests/verified-noop.test.ts`, plus two scripted-loop cases in `tests/agent-loop.test.ts`
(file content and mtime unchanged; fabricated evidence stays incomplete).

**Not changed:** whether the quoted lines actually satisfy the requirement is still the model's
claim; a behavioral check is only enforced where the existing named-code-target rule applies.
