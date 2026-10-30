# Review runs that stall without reading a file

A local-model review could use all its recovery steps without reading anything. In the reported run, `composer-lite` was asked to "Review the project, confirm 5 enhancements to do". It made 12 requests in 2.5 minutes with no tool results, and then the run stopped with "The model did not produce an actionable next step".

Reviews and plans cannot finish without a source read. The grammar that forces a tool call was off for them, blocked by both `reviewOnly` and `chatReply`. So a model that replied in prose could neither finish nor be made to call a tool.

Changes:

- **Forced tool calls:** review and plan runs on local models now get the grammar until a source file has been read, including after recovery. It turns off after the first read, so the final answer stays free prose.
- **Self-read:** at the stall check, the loop reads up to three retrieved files through `executeTool`, with normal policy, evidence and observation handling, then writes findings from them.
- **Reroutes:** a role change that keeps the same model is skipped while no source has been read, so it no longer uses the recovery budget. This is logged as `reroute-skipped`.
- **Follow-ups:** "confirm 5 enhancements" now resolves against the previous recommendations.
- **Diagnostics:** each rejected reply logs `model-reply-rejected` with its length, reason and whether it was constrained. The text is not stored.
- **Stop message:** it now says how many replies arrived without a tool call and that no project files were inspected.

Limits:

- Requests classified as generic get no retrieved files, so only the forced tool call helps them.
- The grammar guarantees valid tool JSON, not a useful call. A model can still choose `tree` repeatedly, and the existing stall check then stops it.
- The scripted model cannot exercise real grammar decoding, and no live `composer-lite` run was done.
- A prose reply that looks complete can still bypass this path; that behavior is unchanged.

Validation: `npx vitest run tests/chat-agent-smoke.test.ts tests/agent-conversation.test.ts tests/user-question.test.ts`. The real agent loop runs with a scripted model. Removing the grammar change, self-read or reroute skip each fails its own test.
