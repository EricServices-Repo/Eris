# #225 — keep tool output past the run

`RunJournal` (#221) closes with its run, so a later turn could not answer "what did that failing test print?".

Each journaled result now also goes to `context_journal` in the conversation's SQLite database, through the worker lane. It is written as it happens, so it survives a crash as well as a restart.

- **Recall:** `context_search` and `context_read` reach it with `j…` refs. It is pull-only. Nothing is added to pushed recall.
- **Labelled historical:** every hit and read carries the date and "says nothing about the current files". Journal text is never promoted to a fact (#138). The original trust label is kept.
- **Same gates as thread recall:** the destination rule, and only refs a search returned can be read. `originThreadRecall` rechecks the origin before and after each call.
- **Secrets:** text is redacted before it leaves main. This is the recall pattern, so it is a filter, not proof.
- **Size:** 1 MiB per entry, keeping the head and the last 256 KiB. The tail starts on a whole line, because a cut could separate a key from its secret. If there is no newline, the tail is dropped.
- **Budget:** `journalThreadMiB`, default 16. Oldest text goes first. Its row stays, and metadata stays indexed, so a search reports `output not retained` rather than no match. Rows are capped at 5,000 per thread.
- **Admission:** the copy waiting for the worker is reserved in the ledger. If refused, only metadata is saved, marked `memory-pressure`.
- **Forget, cutoff, rewind:** each entry belongs to the user message that started its run. Saving a thread or writing controls deletes rows and postings for a source that was forgotten, cut off or rewound, in the same transaction. #148's change replay runs the same purge for changes made by another writer, and reads recheck in case replay has not run yet.
- **Thread delete:** foreign keys cascade to rows and postings.
- **Setting:** `persistToolOutput`, default on. Off stops new saves and leaves in-run recovery alone.

## Known limits

- Forget works at the level of the user message that started a run. There is no control to forget one tool result.
- Turning the setting off does not delete output already saved. Deleting the thread or forgetting the source does.
- Child agents have no `conversationSource`, so their output is not saved.
- Output is not scanned again if the secret pattern improves later.
- Diagnostics runs save nothing.

Verification: `npx vitest run tests/durable-journal.test.ts`. These use the real database and worker handler. The restart test closes and reopens the database. Model turns are scripted, and no live-model or packaged run has been done.
