# #230 — VRAM-first placement

`gpuLayers: { fitContext }` picks the most layers that fit beside the requested window, so it gives layers up to keep the window, with no error. The `'auto'` retry in the issue was only the visible part. Nothing reported the result.

`placeModel()` in `vram-fit.ts` is now the one load path, for the in-process runtime and the worker:

1. `gpuLayers: 'max'` puts every layer on the GPU, or throws.
2. `createContext` searches from the target window down to a 4,096-token floor, from the runtime's own resource estimates.
3. Only if that fails may layers stay on the CPU, and the setting can refuse instead. A spill reserves the floor window, because `'auto'` can spend every byte on layers and leave no room for a context. If that still fails, it reserves the full target, then runs CPU only, which needs no VRAM for a context to compete with.

- **All models:** the ladder ignores `role`. `contextPlan()` keeps `max` as its pre-load forecast and adds `target`, where placement starts, so the fixed headroom thresholds no longer decide a load.
- **Failures:** weights are freed before spilling, and a non-memory error such as a corrupt file is not retried. Every step and its reason go in `placement.steps`.
- **Reporting:** `LoadedModelFacts` carries layers on GPU, total layers, window, estimated KV, device and steps. `context-compiled` events include them through `contextProvenance()`, and Settings → Models shows them with a note when layers are on the CPU.
- **Setting:** `models.allowCpuSpill`, on by default, so a model too big for the GPU keeps working. Off, the load fails with a message naming the setting.
- **Device changes:** the preference toggle and Rescan already dispose the runtime, so the next load runs the ladder again. Hot-plugging a GPU without either is not detected.

## Live measurement

Real Metal on a 16 GiB Apple M4 Mac, `Qwen2.5-Coder-1.5B Q4_K_M` (986 MB, 29 layers), with `llama.setVramCap()` limiting what the runtime may use. That cap is the runtime's accounting, not a physically smaller GPU. Each placed row evaluated tokens through the context.

| Cap (GiB) | `fitContext` layers before | New layers | New window |
| --------- | -------------------------- | ---------- | ---------- |
| 11        | 29/29                      | 29/29      | 32,768     |
| 2.5       | 28/29                      | 29/29      | 32,768     |
| 2         | 19/29                      | 29/29      | 32,768     |
| 1.6       | 12/29                      | 29/29      | 27,392     |
| 1.3       | 7/29                       | 29/29      | 6,400      |

Lower caps exercised the other branches. With spill allowed, 1.25 GiB loaded 9/29 layers at a 10,752-token window, and caps from 1.15 GiB to 0.4 GiB loaded CPU only at 32,768. With spill off, the load was refused with the setting named.

Mock tests alone had approved a first design that was wrong. It combined `min: totalLayers` with `fitContext`, and real runs refused every window even where all layers fit beside a 12,800-token context. A second version spilled with `'auto'`, and real runs failed outright where layers left no room for a context, which is why the spill path now ends on CPU only. The fixtures in `tests/vram-placement.test.ts` now follow what these runs showed.

Known limits: one model on one Metal host. The issue's acceptance also requires a dedicated-GPU host, which has not been run, and generation speed was not compared. The renderer's Settings line has not been viewed in the running app. The worker path shares `placeModel()` but was only type-checked and exercised through it, not in a packaged utility process.

Verification: `npx vitest run tests/vram-placement.test.ts tests/vram-fit.test.ts tests/model-context-allocation.test.ts`, plus the live run above, which is not a committed test because it needs a local model.
