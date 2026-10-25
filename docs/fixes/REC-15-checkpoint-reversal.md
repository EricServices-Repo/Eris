# REC-15 / issue 61: conflict-safe checkpoint reversal

New operations record postimage content digests and file/directory identity. Every successful reverse stores a durable per-operation reversal receipt using atomic metadata replacement. A repeated restore skips reversed operations; legacy interrupted writes/deletions recognize an already restored preimage.

Text writes compare current content to the recorded postimage before restoring. Rename refuses an occupied source or changed destination. Binary creations require recorded digests; ambiguous legacy records fail closed. Created directories remain empty-only and identity checked. Conflict errors preserve files and expose before/agent/current-digest metadata for manual inspection. There is no automatic force-overwrite or three-way merge UI in this fix.

UI restore handlers acquire the project mutation lease and recheck the workspace after waiting. Agent services already holding a lease keep synchronous reversal calls, preventing nested-lease deadlocks. Atomic metadata receipts do not provide a filesystem-wide transaction against external processes; external-editor races and interrupted multi-file recovery remain qualification boundaries.

Validation: TypeScript, targeted ESLint and whitespace checks passed. Existing GitHub CI ran 840 assertions successfully but found one unrelated truncated-stream error-message mismatch; the shared compatibility repair restores its expected Incomplete prefix. Packaged undo/restart and concurrent external-editor scenarios remain integration qualification work.
