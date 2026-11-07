# Truthful task finalization

Chat messages persist optional `contextResult.completion` evidence with separate execution, verification, semantic assessment and task-result persistence dimensions. Older messages remain readable without this field. Execution completion is an observation of the runner, not independent proof that generated code is correct. Verification is invalidated by subsequent edits. A timed-out or malformed evaluator remains unresolved and conservatively leaves the overall task incomplete, while preserving completed execution and verification evidence.

If saving the final task contract fails after execution, chat publishes an incomplete outcome and names the observed changed files. The canonical assistant reply retains this storage warning and completion evidence when chat storage is available. The failed task contract is not automatically replayed; users must inspect applied files before retrying. If canonical chat storage also fails, the existing reply-persistence error remains authoritative and no success terminal is delivered.

Validation: production chat IPC tests inject a final task-save fault and a semantic-review timeout. They assert terminal state, visible applied-change reporting and persisted independent completion dimensions. This is deterministic source acceptance, not installed Windows or live-model certification. Refs #322, #406, #413.
