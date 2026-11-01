# #260 — Fit the first native request to the measured allocation

Stacked on #259, because both change the post-load repack in `chat-runtime.ts`.

`1bd3eef` added the post-load repack: `prepareMessages` runs after `ensureWorkerModel`, rechecks eligibility and packs against what was allocated. This change closes what that left open.

- **Nothing stopped an oversized prompt.** `replyTokenAllowance` floors at 256, so a prompt bigger than the window still generated, and the runtime shifted the context and dropped the start of the prompt, where the task contract lives. The worker now counts the real prompt and refuses before generating. The in-process route does the same.
- **Rebuilt contexts were invisible to main.** The worker rebuilds a context when sequences run out, and main kept budgeting from the old size. The worker now posts `context-allocated`, and main updates the resident model's facts. A rebuild that reports no size clears them, so budgets fall back to the plan.
- **Re-reading capacity dropped the caller's output limit.** Capabilities were replaced wholesale after load. The clamp now applies on every read.
- **The failure names the cause.** When a request does not fit a window smaller than planned, the error gives both sizes rather than advising a larger context setting that would not help.
- **Dispatch tells a plan from a measurement.** Each `context-dispatched` event now has `context: { source, tokens, plannedTokens? }`. `plannedTokens` appears only when the load changed the window.

## Behaviour change

A prompt that needs more than `context − 64 − 128` tokens is now an error. Before, it ran and lost its oldest content silently. A session turn gets its one existing retry first, because the message matches the worker's overflow pattern.

## Known limits

- The main-side listener that applies `context-allocated` needs a real `utilityProcess`, so it is typechecked but not run. Tests cover the worker's post and `updateLoadedAllocation` on either side of it.
- A rebuild during a request can still reject that request. The next one is packed for the new size.
- The scripted loader stands in for a native allocation. No GPU, including a Windows device, was loaded.

Verification: `npx vitest run tests/native-first-request.test.ts tests/llama-worker-context.test.ts tests/model-context-allocation.test.ts`.
