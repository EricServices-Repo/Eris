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

## Correction (harness v2): the production install path does not block for 1.5 s

Finding 1 timed the one-call `install`. Production hydration does not use it.
`hydrateContextMemory` pages the thread from the workspace worker and publishes it
through `installSegments`, which yields every 64 rows. The one-call `install` runs
in production only for a dozen archive or pin rows. The v1 harness also built each
thread about twice its per-thread cap, so the store then trimmed half of it. The
hydration loader stops paging once its estimate reaches the cap, so it never does
that.

Harness v2 defaults to `install: 'segments'`. It pages rows 256 at a time, sizes each
thread the way the loader does, and records the longest event-loop block during the
install (`installMaxBlockMs`) beside its wall time. `--install sync` keeps the v1
behaviour for comparison.

### Electron 44.9.3 main process, Apple M4, 16 GB, `main` 226123a

| Step | Threads | Ledger | Heap growth | RSS growth | Install wall p50 | Install max block | Select max block |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 128 MiB | 1 | 128 MiB | 115 MiB | 225 MiB | 488 ms | 6.2 ms | 1.7 ms |
| 256 MiB | 2 | 256 MiB | 160 MiB | 346 MiB | 375 ms | 2.1 ms | 1.4 ms |
| 512 MiB | 4 | 512 MiB | 251 MiB | 535 MiB | 366 ms | 2.4 ms | 1.3 ms |
| 1 GiB | 7 | 896 MiB | 388 MiB | 780 MiB | 360 ms | 2.8 ms | 1.3 ms |

Every select returned facts. GC stayed at a 3 ms maximum pause.

### What changes in the findings

1. **Hydration does not freeze the main thread.** The longest block while a 128 MiB
   thread installs is 2–6 ms, against about 1.5 s for the one-call path. The
   install still takes about 0.4 s of wall time, spread across yields. The ~40–55 ms
   block in an intermediate v2 run came from `trim()` pruning the oversized
   thread after publish. That is a harness artifact, not the production path.
2. **The full-tier finding is unchanged.** A tier filled to its envelope still
   returns no recall.
3. **RSS growth is below the ledger here, not 1.27× above it.** At 896 MiB ledger,
   RSS grew 780 MiB (0.87×) and the heap 388 MiB. The v1 run allocated each thread
   at about twice its cap and trimmed half. Freed memory need not return to the OS,
   so the v1 RSS figure is not comparable. The ledger is still an
   estimate. The margin acceptance item 2 asks for is not yet established; this
   is one host and one corpus.

### What this means for #228

The main-thread-latency argument for moving the store out of process is weaker
than step 1 suggested: hydration and selection both stay under 7 ms per block at
896 MiB. The remaining reasons are heap headroom for a multi-GiB tier, GC
isolation, and crash isolation. These still need the dedicated-process comparison
(step 2), which is not done.
