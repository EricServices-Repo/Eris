# Provider model qualification

Run the scripted provider setup matrix with `npx vitest run tests/model-switching.test.ts`. The agents qualification profile includes it. The fixture checks admission, resolved selection, child inheritance, bounded recovery and a real agent loop with scripted transport. It uses no provider credentials.

## Live acceptance

- Record the app version and source commit, OS, hardware, model ID and version, provider type, and execution policy. Use a disposable project without private files.
- For Ollama, an OpenAI-compatible API, and a local GGUF, run an Ask turn, apply an Agent edit, run a delegated review, start a background task, and exercise stop and explicit continuation. Record each outcome and any unavailable capability.
- For Auto-local, confirm every selected destination is local in a mixed setup. Replay a review followed by an implementation on cold and warm runs. Record repeat counts, end-to-end latency, window preparation requests, and physical model loads separately.
- Record which checks were scripted, live, or packaged. Record skipped or unavailable cases with their reason and link the results from the qualification PR.
