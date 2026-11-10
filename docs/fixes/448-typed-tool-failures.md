# #448 — Typed tool failures as recovery inputs

Recovery guidance (`recovery.ts`) and receipt metadata (`toolFailureMetadata`) were chosen by
regular expressions over error text. Two observable defects followed:

- `read_file` on a missing path returns `Not found: src/x.ts`, which matched none of the
  missing-file patterns, so the model received generic advice.
- `search_replace` with an absent `old_string` returned `old_string not found in …`, which the
  receipt classified as `unavailable` because the text contains "not found".

**Change.** `agent/tool-failure.ts` defines a bounded `ToolFailureCode` and
`TypedToolFailure { code, retryable, effectApplied, operation, path }`. `classifyToolError` uses
error class (`MutationConflict`, `MutationAppliedError`) and Node errno codes (identical on
Windows and macOS regardless of message language), never message text. `WorkspaceFsError` now
carries a code at every throw site in `workspace-fs.ts` and `execute-tool.ts`.

`executeTool` attaches `failure` to error results; `toolFailureRecovery` and
`toolFailureMetadata` prefer it and fall back to text only for untyped errors (commands, MCP,
web).

**Invariants.**
- `effectApplied` ⇒ `retryable: false` and recovery says *do not retry; re-read to confirm*.
- `permission_denied` is never retryable and its recovery explicitly forbids retrying with a
  different model.

Tests: `tests/typed-tool-failure.test.ts`.

**Not changed:** the loop's tool-execution paths that build their own result objects (git
sync, inline patch fallbacks) still rely on the text fallback; command and network tools are
untyped.
