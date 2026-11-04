# #150 — a source-backed thread summary with no model

Once raw messages leave RAM, a long conversation had no compact view of what was decided and what was left open. Project notes and compaction summaries are separate prose, and neither cites its sources.

`context_read` now accepts the ref `thread-summary`. `buildThreadSummary` derives it from canonical SQLite rows, in the worker, on each read.

- **Deterministic:** no model call, on the send path or anywhere else. Nothing can swap a model during chat.
- **Contents:** user decisions from `declaredDecisions`, user imperatives such as "never…" or "always…", and tasks whose newest recorded state is not finished. Each item cites its message.
- **Corrections:** the newest decision on a subject wins, and it records how many it replaced. Forget the correction and the older decision returns.
- **Failed work:** each unfinished item keeps its end state, such as `failed` or `stopped`. A task that finished later clears.
- **Assistant prose never counts.** Prior answers stay unverified.
- **Metadata:** version, kind, digest, thread, project, timeline and controls revisions, source epoch, messages read, excluded, unreadable, and items over each limit.
- **Limits:** 24 decisions, 16 constraints and 16 unfinished tasks, newest first, at 240 characters each. The scan stops at 20,000 messages, 64 MiB or 1.5 s of worker time (inside the caller's 2 s wait, so a timed-out read does not keep the worker busy), and reports the shortfall and which limit stopped it. Build time is reported as `elapsedMs`, outside the digest.
- **Eligibility:** forget, cutoff and project scope use `recallExcluded`. The destination gate is the one every `context_read` passes. Text is redacted on the way out.

Nothing is stored, so there is nothing to invalidate. A deleted or rewritten source is simply absent from the next read, and the digest changes.

If the summary is unavailable, the tool says so and `context_search` still works.

## Decisions to review

- **No model-generated summaries.** The issue allows them only after an evaluation shows a benefit, and none has been run.
- **Pull only.** The summary is not pushed into prompts, so a model must ask for it. Pushing it needs a budget decision and answer-quality evidence.
- **No cache.** Each read scans up to the limits, in the worker. Add one only if a measurement calls for it.

## Known limits

- A constraint is a line that starts with a fixed word, optionally after a list marker (`-`, `*`, `•`, `1.`) or a short lead-in (please, also, and, important, note). A constraint phrased any other way is missed, though `context_search` can still find it.
- The labelled comparison in the issue, exact retrieval against summaries, has not been run.
- Child agents have no thread recall, so they cannot read it.

Verification: `npx vitest run tests/thread-summary.test.ts`. These use the real database and worker handler. No live-model or packaged run has been done.
