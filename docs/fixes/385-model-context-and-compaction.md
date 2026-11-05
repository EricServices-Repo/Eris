# Model context limits and compaction — issue #385

## Behavior and configuration

Eris accepts requested windows from 512 to 2,097,152 tokens. This is a configuration validation bound, not a promise that a model or GPU supports that window. Existing profiles retain their explicit window (normally 32,768); this change does not silently reserve a million-token local context.

In Settings → Models → Composer, set **Context window** to the requested ceiling. For Qwen3.5, requesting **262144** uses the native trained window when its installed GGUF metadata reports that window and allocation succeeds. A hosted or local OpenAI-compatible connection can override the global request for each exact model ID in its editor. Optional per-model maximum output tokens control the reply reservation. For LM Studio and other servers without readable capacity, that entry is an explicit user declaration, not a measured allocation.

On Refresh models, servers that include `context_length`, `max_model_len`, `context_window`, or OpenRouter-style `top_provider.context_length` in their model-list entries supply an additional ceiling. These facts expire after five minutes and are scoped to the exact endpoint and model. Missing metadata is not inferred from names. Refresh does not add another network request to each chat step. Unknown hosted capacity uses the configured request; the provider can still reject an unsupported value. Unknown loopback capacity retains the conservative 8K fallback unless the user explicitly declares a limit.

Ollama continues to use `/api/show` model metadata, native `num_ctx`, and matching `/api/ps` observations. Its old 128K clamp is removed; a 262K request is bounded by the model's reported capacity and, once available, the matching measured server allocation.

## Native model path

Before initial placement, both worker and in-process loaders read the installed GGUF header through node-llama-cpp. Tensor information and tokenizer arrays are excluded. The architecture's `context_length` replaces a catalog placeholder such as the generic 32K assigned to Hugging Face imports. A bounded cache is keyed by model ref plus path, size, and modification time. Missing, malformed, changed or unreadable metadata returns to the conservative catalog value.

The context target is the minimum of the request, metadata and validation ceiling. There is no universal Lite 32K or full/local 64K cap; older Lite models remain bounded by their own metadata. The existing full-GPU-offload-first placement, quantized KV, memory admission and shrinking-context fallback remain authoritative. Every actual context creation is additionally bounded by the loaded model's `trainContextSize`; this does not enable YaRN or untested extrapolation. The measured allocation controls subsequent prompt budgets.

The installed Qwen3.5-4B-Q8_0 GGUF was read during implementation: architecture `qwen35`, native `context_length` **262144**. This header check did not allocate the model or certify a 262K inference run.

Changing the requested window invalidates same-path runtime reuse. A measured allocation from the old setting is not treated as the allocation for the new request. The request window is passed explicitly through both native loaders and warm-up, including Eris-Dev overrides rather than consulting only the saved profile. The loader rebuilds the context and publishes the actual result, which can be smaller than requested. The settings Memory page distinguishes requested, trained, allocated, usable input and reply-reserve tokens.

## Input accounting

The old unconditional 65% input limit is replaced by:

```
reply reserve = min(model output limit, floor(allocated window * 0.30))
                with a 128-token floor
safety reserve = clamp(ceil(allocated window * 0.02), 128, 2048)
input budget = allocated window - reply reserve - safety reserve
```

Native output retains its existing 16,384-token generation ceiling and actual per-request fit checks. Provider output uses the model override or 16,384 by default, further bounded by advertised output limits when present. Tool schemas are charged separately in the agent/transport paths; instructions, history, recall and evidence share the remaining input. Native post-load packing and token checks remain in place. A bigger context does not bypass task authority, disclosure policy, protocol validation or memory controls.

Example: a 262,144-token allocation with a 16,384-token reply reserve leaves **243,712 input tokens**, before tool-schema deductions. Native inference may allocate far less on constrained hardware. Stored RAM history does not enlarge the active window.

## Compaction and recovery

Recovery no longer forces a rewrite merely because the transcript contains more than four messages. Compaction requires an over-budget prompt, including on empty-response and stagnation recovery paths. Obsolete runtime nudges are bounded before the capacity check.

Once cleanup is needed, micro eviction aims at 80% of the usable prompt budget. This creates headroom for subsequent evidence rather than hovering immediately below the ceiling. Exact readable journal references remain preferred, and the established prefix-safe eviction order stays intact. If micro cleanup gets below the hard budget, another summary call is unnecessary.

A full summary is rechecked and its retained tool evidence is cleaned again. Only a changed, smaller transcript replaces the original and invalidates the GGUF session. Telemetry records reason, before/after estimates, target, budget, effective change and inability to fit. If required context still exceeds the budget, the run reports an actionable context error and preserves existing changes instead of looping on an ineffective rewrite. Transport serialization and native token-fit checks remain the final boundary; estimator output is not a native tokenizer measurement.

## Eris-Dev and verification

Debug schemas now admit the same requested-window range, and the UI includes 64K, 128K, 262K, 524K, 1,010K and 2,097,152-token choices. Production routing, allocation and provider serialization are reused.

Regression coverage includes settings round trips, provider/endpoint isolation, >128K serialized input through an HTTP Ollama fixture, trained native caps, 262K-to-8K placement fallback, metadata refresh and invalidation, settings changes, below-budget recovery, and cleanup headroom. Scripted tests certify these code paths, not physical long-context capacity, answer quality or GPU speed. Real 262K hardware and packaged Windows/macOS long-session qualification remain required before claiming those outcomes. No YaRN configuration or native million-token certification is introduced here.


## Follow-up audit — 2026-11-04

The first implementation shipped in v0.6.13 via #386/#387. Review against main `a893c76` found that the issue was not completely resolved:

- **Reproduced cold-start rejection:** with a 262,144-token native allocation fixture, a 450,000-character current user message was rejected before the loader ran because the performance forecast was only 8K. Native transport now validates the transcript immediately but defers fitting to its post-allocation callback. Training and measured allocation still bound the final send; malformed exchanges remain rejected before loading.
- **First-turn metadata timing:** model metadata was discovered only inside the loader, after the initial agent prompt/history budgets were compiled. Metadata-only preparation now runs before initial turn budgeting, with a warm-cache fast path and cancellation propagation. It does not allocate weights or a GPU context. The allocator refreshes file identity before loading.
- **Accounting mismatch:** compaction counted raw message content while transport also counted serialized roles, tool-result envelopes, JSON escaping and schema text. Both now use shared wire adaptation and framing. A resident tokenizer may supply counts within the existing 250ms deadline; missing counts and changed excerpts use conservative estimates. These are serialized-text counts with framing allowance, not a claim of exact backend chat-template tokens.
- **Revalidation and races:** eligibility checks run before and after asynchronous token counting, including after native allocation and summary generation. Revoked memory/project facts cannot be restored by this preparation step. A tokenizer checks resident model identity before and after each batch, so a concurrent model switch cannot seed the wrong model's count cache.
- **In-flight tool accounting:** a context pull can inspect remaining budget while its tool call is still pending. Pure accounting can adapt that partial exchange; final model dispatch still requires complete, valid tool-call/result pairs. Token budgets for context pulls use the same counter, and reset to conservative estimates when the target model changes.
- **Observability:** compaction events now include count method and elapsed milliseconds alongside reason, before/after counts, target, budget and changed/cannot-fit status. No prompt text is added to those event fields.

Qualification adds a regression that failed on the released code, serialized-tool overhead and escaping fixtures, native prose-density and fallback cases, same-path metadata preparation, cancellation, memory revocation during token counting, partial-tool accounting and model-switch cache isolation. Existing smoke assertions and disclosure boundaries remain in force.

Physical 262K GPU performance, paired live-model answer quality and complete Windows/macOS packaged UX acceptance remain unqualified; passing scripted tests or release packaging must not be presented as that evidence. This follow-up does not enable YaRN, raise the existing 2,097,152-token validation bound or change saved user settings.
