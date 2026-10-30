# #126 — hold derived run state to the recall privacy limit

Remote opt-out removed the recalled block, but a local worker could repeat that text into its own reply, a tool argument, a progress summary or recovery text. All of that stayed in the run and went to a later remote model.

Text has no sentence-level lineage, so this uses a conservative rule at the one place every request passes, `streamModelChat`. When a model first receives a recalled item, the lease records digests of the messages present at that moment. After that, a request to a remote destination the lease does not allow keeps only those messages and compiled system prompts, whose memory items were already removed. Everything else is withheld, the withholding is logged as `derived-context-withheld`, and the model is told earlier steps are not shown. If no user message survives, the current request is restored from the lease, because the user's own input stays permitted.

This covers reroute, compaction, recovery, specialists and final review, because they share that entry point. Call and result records are withheld together, so tool pairing stays valid.

Cost: a remote model that takes over after local-only recall loses the run's working history and may repeat inspection. That is deliberate: losing progress is recoverable, and disclosure is not.

Limits:

- **Next run:** a saved assistant reply can repeat private recall, and it enters a later run as ordinary history. The lease ends with the run, so this is not covered. Fixing it needs lineage stored with messages, so #126 stays open.
- **Work outside the model request:** writing recalled text into a workspace file, then reading it remotely, is not tracked.
- Only requests through `streamModelChat` are covered. Diagnostics adapters use it too.

Validation: `npx vitest run tests/derived-privacy-lineage.test.ts tests/memory-dispatch.test.ts`. A real `streamModelChat` with stubbed transports captures what leaves for each destination. With the guard disabled, the five leak tests fail. No live model, packaged app or real remote provider was used.
