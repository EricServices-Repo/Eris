# #221 — per-run RAM journal

During a run, the message array held the only copy of tool output, and even that was cut to 12,000 characters. Compaction then destroyed what remained.

`RunJournal` keeps one append-only record per run. `loop.ts` writes each executed tool result before `truncateForModel()` runs, so the journal holds the full output.

- **Stable refs:** each entry gets a `ref` when it is written, and `refForCall(toolCallId)` finds it. #222 can use this to build stubs, because tool-call IDs survive compaction's message copies.
- **Metadata:** entries carry the fields the issue lists, plus `toolCallId` and `omitted`. A `run-journal-entry` task event records them without any content.
- **Trust:** `web_search`, `web_open` and `mcp__*` are `untrusted`, `run` is `command`, and the rest are `local`. Untrusted results now carry a label in the prompt. The prompt text is otherwise unchanged.
- **Secrets:** `sensitive` uses the recall pattern, and arguments that match it are not summarized.
- **Storage:** UTF-8 in 1 MiB chunks, outside the V8 heap. `append` and `read` are asynchronous, so the store can move to #228 without an API change.
- **Accounting:** each entry is one reservation in the existing ledger. Caps are 32 MiB per run and 64 MiB across runs. These are first estimates, not measurements.
- **Degradation:** entries are evicted oldest first. A new `onPressure` hook sheds them when pressure rises, so a journal cannot hold memory the governor needs. The entry and its `omitted` reason stay, so `read` distinguishes `omitted` from `unknown`, and missing output never reads as "no such output".

The journal makes no model call and uses no GPU.

Identity: a journal belongs to its run and is reachable only through the runner, so nothing can read across namespaces yet. #149 namespace checks and #148 change events become relevant when #223 and #225 expose journals outside the run.

Known limits: nothing reads the journal yet, so a run's behaviour only changes through the untrusted label; #222 and #223 add that. Under pressure the journal evicts rather than spilling to disk; #225 adds durability. Only executed tools are journaled. Refused calls produce no output to keep. A lone UTF-16 surrogate in tool output becomes U+FFFD, because storage is UTF-8; tool output decoded from bytes does not contain them.

Verification: `npx vitest run tests/run-journal.test.ts tests/agent-loop.test.ts`. These are deterministic checks, plus one scripted run of the real loop. Live-model and packaged runs have not been done.
