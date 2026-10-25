# REC-18 / issue 64: durable review ownership

Keep/Undo is owned by the backend and stored atomically in checkpoint review.json. A decision is keyed by canonical workspace, checkpoint and operation fingerprint. Kept/undone decisions are terminal and replay idempotently. Undo writes an intent before effects; an interrupted intent becomes a conflict that requires manual inspection. Undo reverses selected pending operations in descending operation order and rejects reversal beneath a later overlapping applied operation.

Editor, drawer, Undo pending and auto-keep share this service. Editor undo uses dirty-buffer/document-version protection. Per-operation receipts update UI independently; a partial batch failure never marks every operation undone. Running chat replay loads persisted review status. Decision storage is bounded to 2 MB.

Merge with REC-15 (#61 / PR #89) for filesystem postimage conflict checks, and REC-21 (#67) for centralized transport admission. This review-state layer does not independently replace filesystem reversal validation or provide automatic crash reconciliation; interrupted intent is deliberately preserved rather than retried.

Validation: TypeScript, targeted ESLint and whitespace checks passed. Packaged review/reopen, dirty-buffer interleaving and interrupted-operation scenarios remain integration qualification. Shared CI compatibility restores the Incomplete prefix for truncated model streams.
