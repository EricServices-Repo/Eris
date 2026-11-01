# #222 — compaction evicts to handles

Compaction replaced tool output with an excerpt or a model summary, and its only advice was to "inspect again". For `run`, web and MCP results that means executing again.

Micro-compaction now replaces older output with a stub:

```text
[ref:a1b2c3d4e5f6 · run {"command":"npm test"} · 14220 bytes · starts: … · ends: … · context_read("a1b2c3d4e5f6")]
```

- **Full compaction makes no model call by default.** The resume message keeps the goal, action log and files touched. It also lists a ref for every result still held, rebuilt from the journal each time, so a ref is never summarized away. `agent.summarizeEvictedContext` adds the old summary as an extra; the index stays the copy of the evidence. The setting has no UI yet.
- **Newest safe first.** Outside the protected tail, later output goes first, because a change late in the prompt leaves the longest prefix for KV. Each turn already sets the full history, so a stub-only change no longer calls `releaseGgufSession()`.
- **Pairing:** only `content` changes, so tool calls and results stay paired, and a stub is left alone on later passes.
- **No dead stubs.** `evictionStub()` returns nothing unless the original is resident. A reused tool-call ID also gets no stub, because some servers restart `call_0` each step and the ref could name the wrong output.
- **Fallback:** a result with no readable original keeps today's head-and-tail excerpt, and that full compaction summarizes as it does today. `context-evicted` task events record each pass, with `shortened` and `lossless` showing when this happened.
- **Destination:** a model that can't use `context_read` (#223) gets today's behaviour, so it never sees a handle it can't follow.
- **Secrets and trust:** stubs carry redacted first and last lines, and untrusted output keeps its label.
- **Gates:** gates 1 and 2 now run through eviction, and gate 1 reads the ref printed in the prompt rather than a side lookup.

Known limits: only tool results are journaled, so a run's assistant prose and tool-call arguments in the compacted range survive only through the action log. Stubs saved in an agent session outlive the journal, and a resumed run gets `Unknown ref` until #225. If a run moves to a blocked model, existing stubs are refused with an explanation. Under memory pressure or at the 32 MiB run cap, the journal can drop a result after its stub was written; `context_read` then returns the omission marker. The bounded index states how many results did not fit. KV reuse depends on node-llama-cpp matching the unchanged prefix, which has not been measured.

Verification: `npx vitest run tests/compaction-eviction.test.ts tests/chat-agent-smoke.test.ts tests/run-journal.test.ts` and `npm run check:context`. The 200-result fixture and the real-loop run are deterministic. The acceptance item on fewer full re-evaluations needs a packaged run, which has not been done.
