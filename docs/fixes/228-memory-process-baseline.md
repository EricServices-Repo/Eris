# #228 — RAM tier in the main process: step 1 baseline (RAM-CTX-056)

The issue asks for a measurement before any process split. This is reproduction
step 1: the current ContextMemoryStore filled toward the 1 GiB tier inside the
process that holds it today. Step 2, the same workload in a dedicated memory
process, belongs to the implementation and is not done here.

## Method

`checks/memory-process-baseline.ts`, run by `scripts/measure-memory-baseline.cjs`:

- Threads of about 128 MiB logical bytes each, built from the context-gate corpus
  with unique text per thread, are installed until the ledger reaches 85% of each
  step (128, 256, 512 and 1024 MiB). Below 100% because a tier filled to its
  envelope returns no recall (see the second finding).
- Each install is timed. It is synchronous, so its duration is how long the event
  loop is blocked.
- At each step, 12 selections run across threads. The harness records latency, the
  longest gap between `setImmediate` ticks during each selection (main-thread
  blocking), and whether facts came back. Every recorded selection returned facts.
- GC pauses come from a `PerformanceObserver('gc')`. Heap and RSS are sampled after
  a forced GC (`--expose-gc`), beside `store.ledger.ownedBytes`.

Run in a real Electron main process (`process.type === 'browser'`) and, for
comparison, with `ELECTRON_RUN_AS_NODE`. Raw reports:
`checks/performance/observations/memory-process-baseline-m4.json`.

## Result: Electron 44.9.3 main process, Apple M4, 16 GB

`heap_size_limit` in Electron main: **4,192 MiB**. The step 1 question of whether
the main process heap can hold the tier at all is answered: it can.

|    Step | Threads |  Ledger | Heap growth | RSS growth | Select p95 / max block | Install (sync) p50 / max | GC during fill             |
| ------: | ------: | ------: | ----------: | ---------: | ---------------------- | ------------------------ | -------------------------- |
| 128 MiB |       1 | 128 MiB |     111 MiB |    352 MiB | 5.1 / 1.9 ms           | 1.53 / 1.53 s            | 69 pauses, 45 ms, max 2 ms |
| 256 MiB |       2 | 256 MiB |     161 MiB |    477 MiB | 4.5 / 1.5 ms           | 1.53 / 1.53 s            | 65, 44 ms, max 2 ms        |
| 512 MiB |       4 | 512 MiB |     254 MiB |    783 MiB | 3.5 / 1.5 ms           | 1.43 / 1.56 s            | 131, 108 ms, max 6 ms      |
|   1 GiB |       7 | 896 MiB |     401 MiB |  1,140 MiB | 3.3 / 1.5 ms           | 1.48 / 1.52 s            | 197, 166 ms, max 3 ms      |

The 1 GiB step stops at 896 MiB because the seventh 128 MiB thread crosses the
85% fill target. The Electron-as-Node run matched within noise, except one
1 GiB install that took 3.5 s with an 11 ms GC pause.

## Findings

1. **Installing a thread is the blocking cost, not selecting.** Hydrating one
   128 MiB thread blocks the main thread for about 1.5 s. That is the UI and IPC
   freeze the issue is concerned about. Selection over a full tier stays under
   10 ms with sub-2 ms blocking, and GC pauses stay at single-digit milliseconds.
   That argues for moving or chunking the install path first. Those numbers are
   the step 2 comparison.
2. **A tier filled to its envelope returns no recall.** One 128 MiB thread in a
   128 MiB envelope selects with 0 facts: "Optional recall scratch space was not
   admitted; using recent canonical history." With 31 MiB of headroom
   (2 × `RECOVERY_RESERVATION_BYTES`) it returns 24. A full tier silently falls
   back to recency. Whether the default sizing should reserve that scratch is a
   separate question for the store and is not changed here.
3. **The ledger understates RSS.** At 896 MiB logical, RSS grew 1,140 MiB
   (≈1.27×), while the V8 heap grew only 401 MiB. Most of the cost is outside the
   JS heap (string backing stores and indexes), so heap usage alone does not track
   the tier.

## Limits

- No UI or IPC load ran alongside. These are blocking durations, not observed
  frame drops.
- Synthetic corpus. One unified-memory host.
- Step 2, the dedicated process, and the issue's acceptance items are not done.
