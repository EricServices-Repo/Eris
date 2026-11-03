# Image generation in Eris

Reviewed against integrated `main` `0a54629` on 2026-11-01. Package version: **0.6.10**; published tag `v0.6.10` is the older immutable `f14e409` source. Later source changes require another build.

Eris uses a dedicated image service rather than passing generation requests to its text chat runtime.

## Using it

1. Open Settings → Models → Image Models and choose **Local Hugging Face model**.
2. Download SD-Turbo for a lightweight default, SDXL-Turbo for a larger model, or enter a compatible Hugging Face Diffusers repository URL. Download automatically sets up the private runtime and enables local generation. Review the model card for its download/access terms.
3. Setup needs Python 3.10–3.12 installed. It creates `Eris/image-runtime/venv` and installs PyTorch, torchvision, Diffusers, Transformers, Accelerate, and safetensors. On Windows/Linux with `nvidia-smi`, setup installs a CUDA 12.8 PyTorch build; macOS uses its native PyTorch build.
4. Send `/image a calm blue mountain illustration` in chat. This explicit command works without a downloaded coding model. Attachments and active skills are rejected because this version accepts text prompts only.
5. Inspect the inline result or enlarge it. Use **Save image** with a new `.png` workspace path to copy it into the project. Existing files are never overwritten.
6. In Agent mode, ask Composer to create an image and integrate it into an application. The `generate_image` tool automatically uses the installed image model. Image models never appear in the chat model picker, and the tool has no model/provider argument.

The newest complete local image download is automatically active. Removing it selects the next available complete download. Downloads are explicit settings operations; a tool call never starts a model download or silently falls back to a cloud provider. Optional gated model tokens are saved through Eris secrets under `huggingface.imageToken`.

For an API backend, configure a model-server connection, choose **Image API**, enter its image model ID, enable generation, and save. Its saved API key is reused.

The cloud inline worker does not expose the desktop image service. Explicit artwork requests use the desktop agent loop so it can call the configured provider. Direct `/image` requests always use the dedicated service.

## Data flow

```text
/image prompt ──→ images:generate IPC ──────────────┐
                                                   ↓
Composer ──→ generate_image tool ─────────→ image-generation service
                                                   ↓
                         backend chosen in image settings
                                   ↙               ↘
                local Diffusers worker       ImageProviderAdapter
                      ↓                            ↓
          downloaded Hugging Face model     provider Images API
                                                   ↓
                           bounded response → validated PNG container
                                                   ↓
                                managed PNG + JSON metadata
                                                   ↓
                structured ChatMessage.assets → eris-media preview
                                                   ↓
                               optional new workspace PNG copy
```

- `src/shared/image-generation.ts` defines types, assets, progress events, and command parsing. `image-generation-schema.ts` contains validation so it stays out of the initial chat bundle.
- `electron/main/services/image-generation.ts` owns provider execution and durable media storage.
- `electron/main/ipc/images.ts` handles one active direct generation per renderer, cancellation, and previews.
- `ImageProviderAdapter` is the extension point for other provider protocols. The service dispatches to the dedicated local Diffusers worker or the Images API adapter.
- `generate_image` is an edit tool. Ask/Reviewer agents cannot invoke it. Provider/model selection comes from settings; models cannot select arbitrary endpoints or keys.
- Secrets stay in the main process. Image settings inherited from an untrusted workspace are stripped using the existing workspace trust mechanism.
- Managed media lives under `Eris/media/images/<uuid>.png`, with a metadata sidecar. Chat SQLite stores only asset metadata. A preview resolves a UUID through `eris-media://image/<uuid>`, never a renderer supplied filesystem path.
- Workspace copies use the existing containment/symlink checks and exclusive creation. Agent copies get binary checkpoint records. Undo removes the new workspace file; managed originals stay available in chat.

## Provider contract

The first adapter calls `POST <baseUrl>/images/generations` for base URLs ending in `/v1`, adding `/v1` otherwise. It requests one PNG and expects `data[0].b64_json`. GPT image models receive `output_format: png` and the chosen quality; other compatible models receive `response_format: b64_json`.

Reference: https://developers.openai.com/api/reference/resources/images

URL-only responses are rejected rather than fetching an arbitrary URL. Requests time out after three minutes. Response bodies are limited to 30 MB; decoded PNGs to 20 MB and 4096 pixels per side. Container validation checks signature, chunk bounds, header, data, and end marker. Browser decoding handles actual display; corrupt pixel data may still fail to render and shows an unavailable state.

## Deliberate first-version boundaries

This version supports local or API PNG generation from text. Reference image editing, masks, vision attachments, a ComfyUI workflow adapter, incremental previews, provider image usage accounting, and retention/garbage collection are extension work. Provider billing remains in the provider account. Managed originals are retained when chats are removed.

## Build checks

`npm run test:agents` includes image service tests and a complete scripted agent scenario: generate → save binary → wire into code → finish → undo. Tests mock HTTP/model responses; they do not incur provider charges or prove account/model access. The service tests also cover chat database reload, cancellation, malformed results, invalid paths, and existing-file protection.

## Local generation lifecycle

`local-image-model.ts` manages a separate `Eris/models/images` catalog and private Python environment. `resources/image-generation/worker.py` receives one JSON request over stdin and emits bounded JSONL results/progress. Prompts and tokens are never shell arguments. Subprocesses exit after inference, releasing image model memory for coding models. Cancellation/timeout kills the worker, removes generation temporaries, and leaves resumable Hugging Face partial downloads for retries. Only one local setup/download/generation operation runs at a time.

Downloads pin the repository commit, select one safetensors variant per component, include configuration/tokenizer files, reject custom pipeline Python/pickle weights, and verify downloaded weight SHA256 values. A complete manifest is published only after verification; partial models are never used automatically. Initial support covers Stable Diffusion and SDXL Diffusers pipelines, including SD-Turbo and SDXL-Turbo. Standalone `.safetensors` checkpoints, GGUF files, LoRAs, and FLUX pipelines need additional adapters.

Inference sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `local_files_only=True`, and `use_safetensors=True`. CUDA selects the GPU with most free memory and uses CPU offloading, with sequential offload below 4 GB free. Apple Metal and CPU paths are supported. CPU generation is slower; this version reloads the pipeline for each request rather than reserving GPU memory while the coding model runs. Turbo generations use a native 512 px budget and two steps. Other supported pipelines use 20 steps and a one megapixel limit. The image card reports actual output dimensions. The local timeout is 15 minutes.

Sources: [Diffusers loading](https://huggingface.co/docs/diffusers/using-diffusers/loading), [Hugging Face downloads](https://huggingface.co/docs/huggingface_hub/guides/download), [SD-Turbo model card](https://huggingface.co/stabilityai/sd-turbo), [PyTorch installation](https://pytorch.org/get-started/locally/).

Local tests use a real subprocess protocol simulator and execute the real Python worker with simulated ML dependencies. They cover automatic selection, keeping models out of the chat catalog, cancellation, cleanup, no cloud fallback, download selection/integrity, and offline generation parameters. They do not benchmark an actual GPU or download production weights.

## Resource and Metal safeguards

Local generation uses the shared inference governor and its exclusive GPU/device lease. When the image lease owns the device, the idle text runtime can be released before memory is measured again. The service selects a complete installed image model that passes preflight; a safer installed fallback is reported, and no fitting candidate yields an explicit refusal rather than an unrequested cloud generation/download.

For CPU/MPS shared-memory devices, current conservative preflight requires at least 24 GiB total / 6 GiB free for SDXL, or 12 GiB total / 3 GiB free for the other supported pipeline. Estimated working set is weights × 1.55 (SDXL) or × 1.25 plus 2 GiB, and cannot exceed 68% of total memory. These are code thresholds, not quality or hardware benchmark results.

The subprocess sets MPS high/low watermark ratios 0.75/0.60 and a 0.60 per-process memory fraction where supported, and repeats device/host checks before loading. Cancellation, worker exit and timeout retain explicit failure semantics and cleanup. The default inference timeout is 15 minutes; setup/download stages have their own bounds. This protects an M4 desktop from obvious unsafe SDXL loads without promising that every accepted native workload cannot stall or exceed physical memory.

Read [local-image-model.ts](../electron/main/services/local-image-model.ts), [Python worker](../resources/image-generation/worker.py), [admission design](changes/REC-32-inference-admission.md) and [runtime repair](changes/REC-33-image-runtime-repair.md). Live CUDA/MPS/model quality and packaged setup remain separate acceptance from protocol simulators.
