# #223 — let the model pull context from RAM

Recall was push-only: one query, once per submission, with the raw user text. Anything that query missed stayed out of reach for the rest of the run.

`context_search` and `context_read` are read-effect tools on both tool protocols. `ContextPull` (`agent/context-pull.ts`) serves them.

- **Run scope** searches and reads this run's journal (#221).
- **Thread scope** goes through `conversationContext()`, so forgotten sources, cutoffs, project scope, evidence revalidation and the critical-pressure fallback are the ones pushed recall uses. `explicitSearch` narrows that selection to real term matches and drops pins, which are already in the prompt.
- **Reads recheck everything.** `readConversationSource()` takes fresh durable controls and transcript rows, and shares `recallExcluded()` with selection. A source the user forgets after it was found cannot be read. Only refs a search returned can be read, so a ref can't be guessed into a source.
- **Destination:** `contextPullAllowed()` is the rule `memoryForDestination()` uses, and it also requires recall to be enabled. It hides the tools and is rechecked on every call, because a run can change model. A blocked call returns nothing from either scope, including run scope, even though that destination saw those results originally.
- **Authority:** results sit inside a fence with a random mark per result, so recalled text cannot print a matching end line.
- **Secrets:** text is redacted before it is matched or returned, so search can't probe for a secret. Pushed recall drops a sensitive excerpt whole, but a read keeps the surrounding text. Otherwise any file containing `password: string` would be unreadable.
- **Limits:** one page is at most 8,000 characters and a quarter of the window still free, with a 256-character floor. A run gets the larger of 24,000 characters or twice its window. These are first estimates. An identical repeat is refused until compaction removes the first answer.
- **Deadline:** 2,000 ms, the schema's ceiling, instead of the 150 ms send-path default.
- **Record:** each call adds a `context-pulled` task event with refs, digests and sizes, never recalled text or the query.
- **No recursion:** pull results are not journaled, so search can't find its own output.

Known limits: child agents get no thread scope yet, which #151 covers; their `conversationSource` is unset. `context-pulled` is a task event, not part of `ContextBundle`, because pulled text arrives as a tool result after the bundle is compiled. Search is lexical until #234. A search decodes the resident journal each time, yielding every 4 MiB; a 32 MiB journal is the worst case. A secret that does not match the recall pattern is not redacted, and pushed recall has the same limit.

Verification: `npx vitest run tests/context-pull.test.ts tests/chat-agent-smoke.test.ts`. Run and thread scope use the real journal, store and SQLite database. The loop tests script the model on both protocols. Removing the destination gate, read redaction or read-time exclusion each fails the suite. No live-model or packaged run has been done.
