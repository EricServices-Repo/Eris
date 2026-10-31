# Windows: recover when an 8,192-token context cannot fit

## Root cause

The context plan for full/local models uses an 8,192-token minimum. The native allocator searches the supplied minimum/maximum range; if even the minimum cannot fit, it throws `InsufficientMemoryError`. Both Eris runtime paths previously retried the exact range using an unquantized KV cache. That does not reduce the window and can increase VRAM demand, so retrying the chat repeated the failure.

## Implementation

`createContextWithVramFallback` in `electron/main/services/vram-fit.ts` is shared by the isolated worker and compatibility runtime. It preserves native range selection on the first attempt. On memory exhaustion it halves the minimum and retries a fixed smaller context (8,192 → 4,096 → 2,048 → 1,024 → 512), preserving quantized KV. If quantized KV is unsupported, it still supports the existing default-cache fallback; memory exhaustion in that path also reduces the window. Other default-cache errors propagate immediately. Retries stop at 512 tokens and preserve the original final error.

The native allocation is still measured and recorded, so subsequent context compilation and reply budgets use the allocated window. Failed worker loads dispose weights/context; failed compatibility loads dispose the model before propagating the error. Starting a worker model replacement clears stale model-path and measured-capacity state.

## Validation and limits

`tests/vram-fit.test.ts` reproduces the reported Windows error with a fake allocator and tests successful shrinking, native range selection, unsupported quantization, exhausted retries, and unrelated failures. Full typecheck/lint/tests are run separately.

This is deterministic allocation-failure simulation, not certification on a Windows CUDA device. If model weights plus the smallest context cannot fit, allocation still fails safely. The first cold-load prompt is currently compiled against the plan before load; shrinking the window does not by itself recompile an oversized first prompt. That remains the documented allocation-before-compilation follow-up from #243.
