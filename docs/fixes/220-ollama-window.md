# #220 — Ollama window and residency are managed

Eris budgeted for the 32K setting but never told Ollama. Ollama's documentation confirms that `/v1/chat/completions` cannot set a context size, and that the default is as low as 4K below 24 GiB of VRAM, so the two could silently disagree.

- **Verified route:** a connection labelled Ollama is probed with `/api/show`. When that answers, requests use native `/api/chat` with `options.num_ctx` and `keep_alive`. When it does not, requests stay on the OpenAI-compatible route, so a mislabelled server keeps working.
- **Window:** `num_ctx` is the smallest of the context setting, the model's `context_length` and Eris's 128,000 cap. Probing runs when a turn starts and again before dispatch, so budgets use it from the first request.
- **Measurement:** `/api/ps` is read after each request. A loaded window counts as `measured-allocation` only if it came from a request with the same `num_ctx`, so an old record cannot pin the budget after the setting changes.
- **Residency:** `keep_alive` is `30m` during active use, or indefinite with the per-connection "Keep model loaded" option.
- **Partial CPU:** Settings → Models shows the requested and loaded windows and the VRAM share. A warning is also logged.
- **Unverified servers:** any local server that cannot be verified, including LM Studio, budgets at `min(setting, 8,192)` with `contextSource: 'unverified-window'`. Hosted providers keep their configured ceiling.

A prompt over the budget is refused before dispatch, so the server never has to truncate it from the front.

Known limits: LM Studio documents a model's maximum window but not the loaded one, so it stays unverified. The 8,192 value is a judgement call and can be too high for a server loaded at 4,096. `context_length` in `/api/ps` is optional; without it the source stays `runtime-plan`. The native API has no `tool_choice`, so `required` behaves as `auto`. Partial CPU is shown in Settings, not in the chat view.

Verification: `npx vitest run tests/ollama-runtime.test.ts`, against a scripted server implementing the documented protocol. No live Ollama was available, so the issue's live truncation and `prompt_eval_count` checks are still outstanding.
