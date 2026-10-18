# Image generation in Eris

Eris uses a dedicated image service rather than passing generation requests to its text chat runtime.

## Using it

1. Open Settings → Providers → Image generation and choose **Local Hugging Face model**.
2. Download SD-Turbo for a lightweight default, SDXL-Turbo for a larger model, or enter a compatible Hugging Face Diffusers repository URL. Download automatically sets up the private runtime and enables local generation. Review the model card for its download/access terms.
3. Setup needs Python 3.10–3.12 installed. It creates `Eris/image-runtime/venv` and installs PyTorch, torchvision, Diffusers, Transformers, Accelerate, and safetensors. On Windows/Linux with `nvidia-smi`, setup installs a CUDA 12.8 PyTorch build; macOS uses its native PyTorch build.
4. Send `/image a calm blue mountain illustration` in chat. This explicit command works without a downloaded coding model. Attachments and active skills are rejected because this version accepts text prompts only.
5. Inspect the inline result or enlarge it. Use **Save image** with a new `.png` workspace path to copy it into the project. Existing files are never overwritten.
6. In Agent mode, ask Composer to create an image and integrate it into an application. The `generate_image` tool automatically uses the installed image model. Image models never appear in the chat model picker, and the tool has no model/provider argument.

The newest complete local image download is automatically active. Removing it selects the next available complete download. Downloads are explicit settings operations; a tool call never starts a model download or silently falls back to a cloud provider. Optional gated model tokens are saved through Eris secrets under `huggingface.imageToken`.

For an API backend, add a connection in Providers, choose **Image API**, enter its image model ID, enable generation, and save. Its saved API key is reused.

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
