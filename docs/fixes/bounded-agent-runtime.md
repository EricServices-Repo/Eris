# Elapsed agent execution budget

Settings → Agent exposes `maxRunMinutes` (1–120 minutes, default 15). This elapsed execution budget starts at the production agent-runner boundary and covers all its steps, retries, tools and inline specialists. Nested workers inherit the parent's cancellation signal, so a new child budget cannot extend the parent. Existing step limits and native silence watchdogs remain in effect. Initial chat admission/intake and final semantic assessment have their existing separate limits.

When the deadline expires, the runner cancels its owned work and returns an incomplete result preserving observed applied paths and any partial answer. User cancellation remains cancellation, not a deadline failure. The chat cancellation path also names recorded applied paths before persisting its stopped reply. No uncertain write is replayed automatically.

Model delivery races cancellation even if an adapter ignores its signal. Late model chunks are dropped and cannot begin another tool step. Iterator cleanup is requested without allowing a stuck producer to hold the caller; the underlying runtime still owns process termination and resource release. Filesystem effects are not detached by this model-only race: tool cleanup follows its existing cancellation boundary before the runner finishes. A broken host tool that ignores cancellation still requires its own recovery mechanism.

Native step logs now record output-token count and effective output tokens per dispatch second when the runtime supplies token counts. The rate includes prefill and is unavailable, rather than estimated, when output tokens are not reported. No raw prompts are logged.

Tests cover an actual applied fixture write followed by a stalled model, abort-ignoring adapter delivery, pre-cancelled adapters, cancellation after a write and existing task/terminal behavior. Windows GPU throughput and memory safety still require real hardware measurements. Refs #406, #338, #349.
