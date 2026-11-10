# #456 — Protect against external edits between read and write

`TaskToolGateway` already compared a workspace edit against a stored read hash, and
`MutationPlan` identities already guard publication. Three gaps remained:

1. **Baseline adopted external changes.** `record()` re-hashed the file from disk after the read
   returned, so an edit landing between the read and its receipt became the trusted baseline.
   `readWorkspaceFile` now returns `revision` (sha256 of the exact bytes the model saw) and the
   gateway stores that.
2. **Absent-at-read files.** A `read_file` that reported *Not found* recorded nothing, so a file
   created externally afterwards could be overwritten by `write_file`. The gateway now records a
   `missing` baseline and conflicts if the path exists at authorization. Creating a file that is
   still absent is unaffected.
3. **Misleading conflict text.** A planned identity that changed while waiting for the project
   write lock threw `MutationConflict` inside `authorize`, which was reported as
   `Invalid scoped tool path.` It is now reported as a stale-edit conflict.

All conflicts tell the model to re-read and state that the external change was preserved.
After a re-read the edit proceeds normally. Tests: `tests/stale-write-guard.test.ts` (three of the
six fail on the previous gateway).

**Not changed:** the post-own-edit baseline is still re-hashed from disk; reads that reach the
model outside `read_file` (retrieval injection, open buffers) still do not set a baseline, which
read-before-edit enforcement already covers.
