# REC-34: chat and workspace performance qualification

Implemented 2026-10-27 against main `6284be3` / Eris 0.5.0. The issue predates the current variable-height VirtualList. Baseline profiling showed bounded DOM already; actual failures were lost selection and focused controls while scrolling. The fix preserves that virtualizer instead of replacing it.

## Interaction contract

HistoricalMessages opts into a maximum 119-row window plus one focused row. Stable keys and spacer gaps keep that control in its logical position. Chromium can blur a moved keyed element; only the retained connected control is restored. Explicit outside interaction clears ownership. List/listitem semantics expose logical positions and total size. Existing resize measurement and prepend anchors remain.

Noncollapsed native selection freezes the current bounded range by first/last message ID, including across prepends. Scrolling far outside can therefore show a spacer until selection clears. This tradeoff preserves selection without mounting intermediate history. Search navigation clears the old selection. Cooperative cancellable search scans loaded message content in batches, with a 150ms debounce. Enter/Shift+Enter and Previous/Next reveal logical results without mounting full history. Unloaded database history and browser native find are outside this search contract.

## Reproduction

Run `npm run check:performance` after `npm ci`. Disposable fixture builds use actual HistoricalMessages, MarkdownMessage, chatStream, diff worker, workspace index worker and symbol API. No provider/model is called. Temporary appData/userData isolate real Eris settings. CI uploads `out/qualification/ui-performance.json`. Reports retain raw samples, nearest-rank p50/p95, runtime, hardware, Git revision, source SHA-256 digests and budget applicability.

The UI fixture starts with 10,000 alternating messages (6,417,780 content characters), prepends five pages of 200, and checks search/selection/focus/anchors. It measures 20 scripted answer-buffer and input updates, and five Stop UI updates while computing a 5,000-line diff. Token-to-paint is buffer mutation through two animation frames; Stop measures a fixture button's React update, not native inference cancellation. Typing uses DOM input events through paint. Diff latency measures request to worker result during concurrent UI work. The production index fixture generates 4,000 TypeScript files (~3.4MiB), checks all are indexed, runs three warm rebuilds and 20 real source-hit queries, then removes temporary files/workers.

## Budgets and actual evidence

`checks/performance/budgets.json` defines Apple M4/arm64/16GiB reference budgets: token/typing/Stop p50 50ms / p95 100ms; diff 250/1000ms; renderer JS heap 128/192MiB; longest recorded long task 250ms; warm index 15/20 seconds; useful evidence 100/250ms. Matching hardware with missing/nonfinite metrics fails as incomplete. Unknown hardware reports timings without certification. All hardware gates mounted rows <=120, anchor error <=8px, preserved interactions and zero model calls. Initial budget values are fixture limits, not universal production SLOs.

Recorded on Apple M4, 10 logical CPUs, 16GiB macOS arm64, Electron 44.9.3 / Chromium 152.0.7977.167: baseline kept seven rows mounted and zero drift, but lost focus/selection and lacked loaded-history search. Final interaction checks pass with 11,000 loaded messages, bounded DOM and <1px drift. Raw reports are in `observations/` beside the budget file. The initial baseline retains its legacy quantile calculation and is marked accordingly: use raw samples/recompute nearest-rank before comparing timing. No speedup is claimed from noisy run differences.

## Limits

The long-task observer starts after initial mounting; no entries means no recorded long tasks in that window, not proof of no startup stalls. Longest-recorded-task zero is the empty-window maximum. Heap samples cover renderer JS only, not total app/GPU memory. Main RSS is recorded for indexing; worker memory is unavailable. Three warm rebuilds do not establish a reliable tail distribution. OS caches are not flushed. Cold model load, actual inference cancellation, live models, GPU stress, Windows performance, packaged accessibility and whole-app memory remain unqualified. Native selection spanning unmounted windows and screen-reader navigation through every unloaded row remain UX follow-up.
