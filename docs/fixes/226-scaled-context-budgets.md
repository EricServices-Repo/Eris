# #226 — scale recall and history with the window

Budgets were constants: 1,024 recall tokens, a six-message tail, and 6,000 or 24,000 history characters. That was 19% of an 8K window's input budget and 2.4% of a 64K one, so a larger window recalled nothing extra.

`allocateContext(inputTokens, taskClass, recallCeiling)` in `src/shared/context-allocation.ts` is now the one split.

| Budget | Share of input | Floor | Cap |
| --- | --- | --- | --- |
| Recall | 15% | 128 | 8,192 |
| History, chat | 37.5% | 1,000 | 48,000 |
| History, agent | 10% | 500 | 16,000 |

Everything else stays with the task, instructions, tools and current evidence, at least 40% of input at any window. A floor never takes more than a quarter of a very small window. The 15% comes from §14.3 and the history shares were chosen so a 32K window keeps about today's budgets. None of these numbers come from an evaluation.

- **One split per turn:** `chat-stream` allocates once, then passes that value to recall and to `buildChatMessages()`, so `coveredSourceIds` describes what the prompt sends. No code has a separate 6,000 or 24,000 any more.
- **Token-based tail:** `compactHistory()` admits messages newest first while the budget lasts, and still keeps at least six, so a long answer can't evict the request it answers. The older summary scales too.
- **Canonical history:** the prompt now gets all 60 messages the transcript returns. Routing and task intake still read the last 20.
- **`promptTokens` is now a ceiling.** Its maximum is 8,192, which is also its new default, so an unset value doesn't limit recall. A value someone saved stays as their ceiling, which means a saved 1,024 keeps today's behaviour. Settings text says ceiling.
- **Evidence:** #141's reservation in the compiler is unchanged. Recall is sized before compilation, and the compiler's historical cap still applies. The inspector asks for the same recall size a send to that model would use.

Known limits: the window comes from the model planned when recall runs. A later fallback from Composer Full to Lite keeps the larger split, and provider budgeting and compaction still bound what is sent. The transcript's 60-message page caps history at large windows, so 48,000 tokens is rarely reached. Budgets use the 3-characters-per-token estimate until #229.

Verification: `npx vitest run tests/context-allocation.test.ts tests/agent-context.test.ts tests/chat-stream.test.ts`. Two existing assertions pinned the six-message tail and were updated. The paired live-model precision evaluation in the acceptance criteria has not been run.
