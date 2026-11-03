# #231 — mmap for fully offloaded models: probe and unified-memory baseline (RAM-CTX-059)

The issue gates any change on a **Windows dedicated-GPU** measurement. That host
was not available. This adds the probe and records a **unified-memory** baseline,
which supports the issue's third acceptance item: unified-memory behaviour should
stay unchanged. It changes no Eris behaviour, and `useMmap: 'auto'` stays in
`vram-fit.ts`.

## Probe

`scripts/measure-mmap.mjs --model <gguf> [--repeats 3] [--out report.json]`.

- **Load options.** Each sample is a fresh child process loading the model as
  `fullOffloadOptions` does (`gpuLayers: 'max'`, flash attention), with `useMmap`
  forced on or off. It creates a 2,048-token context and samples memory 1.5 s after
  the load settles.
- **Order.** Modes alternate (on/off, off/on, …), so neither one always inherits
  the other's cache.
- **Memory sources by platform:**
  - darwin: `vm_stat` file-backed pages; available = free + purgeable + inactive.
  - linux: `/proc/meminfo` `MemAvailable` and `Cached`.
  - Windows: `os.freemem()` only. A file-cache figure there needs a performance
    counter and is not collected. That path is untested.
- **File cache.** The OS file cache is **not purged** (that needs root), so later
  samples may load from a warm cache. The per-sample order in the raw report shows
  which was which.

## Unified-memory result: Apple M4, 16 GB, Metal, all layers on GPU

Medians of 3 per mode. Δ values are system-wide, before load to after load.
Raw samples: `checks/performance/observations/mmap-m4-unified.json`.

| Model (file)                        | mmap | Load (samples)                        | Process RSS | Δ available | Δ file cache |
| ----------------------------------- | ---- | ------------------------------------- | ----------: | ----------: | -----------: |
| Qwen2.5-Coder-1.5B Q4_K_M (940 MiB) | on   | 374 ms (334, 374, 440)                |   1,252 MiB |    −222 MiB |            0 |
|                                     | off  | 453 ms (444, 453, 486)                |   1,628 MiB |    −997 MiB |     −104 MiB |
| Qwen2.5-Coder-7B Q4_K_M (4,466 MiB) | on   | 2,008 ms (2,785, 2,008, **440** warm) |   4,749 MiB |    −575 MiB |   +3,274 MiB |
|                                     | off  | 2,080 ms (1,961, 2,080, 4,024)        |     799 MiB |  −2,396 MiB |   −4,177 MiB |

Reading it on unified memory:

- **mmap on loads no slower and costs less available memory.** With mmap on, the
  weights' pages are the file cache, so a warm reload of the 7B model took 440 ms.
  With mmap off, every load copies the file into Metal buffers (2–4 s for 7B). That
  copy also evicted about 4 GiB of other file cache and lowered available memory
  more.
- **RSS misleads on Metal.** With mmap on, RSS counts the mapped file (4.7 GiB for
  7B). With mmap off, it hides the Metal allocations (0.06–0.9 GiB) even though the
  GPU holds the same 4.5 GiB. Pressure logic should not read process RSS as model
  cost.

Nothing here argues for changing unified-memory behaviour.

## Not measured: the issue's actual question

On a dedicated GPU the weights are copied to VRAM. With mmap on, the host file
cache may keep a second copy that a large RAM tier then sees as used. Whether
that matters, and whether mmap off is still slower to load there, needs the probe
run on a Windows dedicated-GPU host (acceptance item 1). The Windows path records
only `os.freemem`, and a file-cache counter would make that run more useful.

## Limits

- **System-wide deltas are noisy.** On a 16 GB host with other processes running,
  the 7B rows include cache churn from the samples before them.
- **No purge.** The cold/warm split is visible only in the per-sample order.
- **No Eris code path.** The probe calls node-llama-cpp with Eris's options,
  not `builtin-model.ts`.
