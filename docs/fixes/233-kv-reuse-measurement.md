# #233 — KV reuse across turns: measurement (RAM-CTX-061)

The issue ships KV reuse only if a measurement justifies its memory. This records
that measurement on one unified-memory host. It does not change Eris.

## Method

`scripts/measure-kv-reuse.mjs` drives node-llama-cpp 3.22.1 directly, outside Eris,
against a local GGUF. A deterministic synthetic thread of N user/model turns is
followed by one new question, timed to the first generated token after one warmup:

- **fresh:** a new context sequence, so the whole history is evaluated again. This
  is what a per-run native session costs today (CONTEXT-MEMORY.md: no cross-turn
  KV reuse).
- **retained:** the same sequence as the previous turn. Only the new message is
  evaluated.
- **parked:** the thread's state was saved with `saveStateToFile`, the sequence then
  served a different thread, and the state was loaded back with
  `loadStateFromFile(…, { acceptRisk: true })`. The load time is included.

Three repeats per row; medians reported, with all samples in
`checks/performance/observations/kv-reuse-m4.json`.

## Result: Apple M4, 16 GB unified memory, Metal, context 8192, all layers on GPU

| Model                     | History  |  Fresh | Retained | Parked (incl. load) | Evaluated tokens (fresh → retained) | State file | Save / load  |
| ------------------------- | -------- | -----: | -------: | ------------------: | ----------------------------------- | ---------: | ------------ |
| Qwen2.5-Coder-1.5B Q4_K_M | 24 turns |  3.7 s |    53 ms |               61 ms | 3,268 → 19                          |     89 MiB | 26 / 9 ms    |
| Qwen2.5-Coder-1.5B Q4_K_M | 48 turns |  9.0 s |    74 ms |               87 ms | 6,580 → 19                          |    180 MiB | 55 / 17 ms   |
| Qwen2.5-Coder-7B Q4_K_M   | 24 turns | 22.4 s |   262 ms |              304 ms | 3,268 → 19                          |    178 MiB | 45 / 55 ms   |
| Qwen2.5-Coder-7B Q4_K_M   | 48 turns | 52.9 s |   311 ms |              401 ms | 6,580 → 19                          |    359 MiB | 197 / 113 ms |

## Reading it

- **Latency justifies the feature.** On a long thread, re-evaluating the history
  dominates time to first token: 50–170× slower than a retained sequence. Parking
  and reloading a thread costs a few tens of milliseconds more than keeping it.
- **Memory is the real cost.** A parked state is the KV of every token in it:
  about 28 KB per token for the 1.5B model and 57 KB for the 7B one, at this
  runtime's default KV type. One 48-turn 7B thread is 359 MiB on disk. An LRU cap
  must be in bytes, not thread count, and the files are conversation data
  (forget, delete and retention rules apply, per the issue).
- **Retaining costs no extra VRAM while the thread is active.** The sequence already
  holds that KV at the end of a turn. Keeping it only defers its release.

## Limits

- One host class (unified memory). Dedicated-GPU hosts were not measured; there the
  retained KV is VRAM the next model load cannot use.
- Synthetic, deterministic thread text. Real threads with tool output are larger
  per turn.
- Measures the runtime capability, not Eris. Eris's prompt compiler changes the
  prefix between turns when recall or task blocks change; #232 orders the stable
  prefix first, but how much of a real Eris prompt stays reusable turn to turn was
  not measured.
- No crash-safety, mismatch-refusal or invalidation work: those are the
  implementation's acceptance items and remain open.
