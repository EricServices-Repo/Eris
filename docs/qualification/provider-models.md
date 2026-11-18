# Provider model qualification

Run the scripted provider setup matrix with `npx vitest run tests/model-switching.test.ts`. The agents qualification profile includes it. The fixture checks admission, resolved selection, child inheritance, bounded recovery and a real agent loop with scripted transport. It uses no provider credentials.

## Live acceptance

- Record the app version and source commit, OS, hardware, model ID and version, provider type, and execution policy. Use a disposable project without private files.
- For Ollama, an OpenAI-compatible API, and a local GGUF, run an Ask turn, apply an Agent edit, run a delegated review, start a background task, and exercise stop and explicit continuation. Record each outcome and any unavailable capability.
- For Auto-local, confirm every selected destination is local in a mixed setup. Replay a review followed by an implementation on cold and warm runs. Record repeat counts, end-to-end latency, window preparation requests, and physical model loads separately.
- Record which checks were scripted, live, or packaged. Record skipped or unavailable cases with their reason and link the results from the qualification PR.

## Ollama maximum context

In Settings → Models → Auto model profiles and priority, choose the model, set
Context sizing to **Use model maximum (Ollama)**, and save the profile. This opts
that model into its `/api/show` maximum, up to Eris's 2,097,152-token validation
ceiling. It overrides the global context setting, saved profile window and
connection model limit. Other providers and Eris Cloud require configured limits.
Disabling the profile restores the previous sizing behavior.

Before dispatch, Eris reads `/api/ps`. If necessary it loads the runner using an
empty native chat at that exact `num_ctx`, then checks the reported loaded window.
A missing maximum, missing allocation, smaller allocation, load error or timeout
stops the request before conversation data is sent. There is no smaller-window
retry in maximum mode. This policy overrides connection Fit/Max: previously learned
fits are ignored, and CPU spill or inference allocation failures do not record a
smaller fit. Disabling the model profile resumes the connection's configured fitting
policy. The empty load can take up to ten minutes and is cancellable.
No VRAM-per-card restriction is applied; Ollama controls placement and parallel slots.
A metadata maximum is a supported target, not proof it fits server memory.

Prompt packing still reserves space for output, tools and framing. History now
scales with the usable input window (10% for Agent, 37.5% for Chat), without the
former 16K/48K caps. Recall uses up to 15%, with a configurable ceiling up to
131,072 estimated tokens and up to 256 relevant excerpts. Saved lower recall
ceilings are preserved; raise Recalled context token ceiling in Memory settings
when needed. This does not send every stored conversation or file automatically.

Scripted verification is in `tests/ollama-runtime.test.ts`,
`tests/context-allocation.test.ts` and `tests/context-memory.test.ts`. Live acceptance
must additionally record requested and loaded context, server parallelism, cache
quantization and memory placement, then retrieve unique facts near both ends of
a long prompt. Scripted transport tests cannot establish physical GPU fit or model
recall quality. Another client can reconfigure a shared server after the check.
