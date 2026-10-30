# #131 — reserve transient context memory before allocating it

`logicalBytes` counted installed records only. Hydration pages, the arrays built during a load and old snapshots held by a running selection all sat outside it, so concurrent work could exceed the envelope while the figure stayed compliant.

The store now keeps one estimated ledger against `maxMemoryMiB`:

- **Owned:** installed threads.
- **Reserved:** hydration bytes, charged before each worker page is requested. One page is charged as 4 MB, the most a 2 MB UTF-8 page can decode to.
- **Pinned:** snapshots a selection still holds after the store has let go of them. A snapshot the store still owns is not charged twice.

A reservation evicts other cold threads to make room, never the thread being loaded. If there is still no room, the load stops and installs what fits, or installs nothing if the first page cannot be admitted. Recall then falls back to recent canonical history.

Ownership moves to the store in one step inside `install`. Hydration releases in `finally`, so aborts, worker failures and late replies each release once. An abort does not release a page already requested, because that reply still arrives and occupies memory.

The dialog data now carries the ledger as `inspection.ledger`, separate from process heap counters.

Limits:

- These are estimates, not heap measurements. No RSS or heap figure was collected, so the issue's measurement criterion stays open.
- Immutable segment handles and bounded scratch arenas were not added. Selection scratch, such as ranked candidates and excerpts, is not charged.
- Pins are released when selection ends, and selection is bounded by the existing foreground deadline, not by a separate cap.
- Renderer history (#143) is not charged here. It can use `reserve` later.

Validation: `npx vitest run tests/context-memory-reservations.test.ts`. 13 deterministic tests covering concurrency, eviction, exact release, stale installs, pinned snapshots, cancellation, worker death and late replies. With the `finally` release removed, the three failure-path tests fail. No packaged app, hardware or heap measurement.
