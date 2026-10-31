# #216 — generation leases stop re-charging a loaded model

Every generation took a lease of `approxBytes * 1.25 + 1 GiB`, counted in full as pending host memory, even when the model was already loaded or lived on a dedicated GPU. That pushed pressure to `critical`, which emptied the RAM store.

`textHostReservation()` now sets the host charge from placement. A dedicated GPU holding the whole peak charges 1 GiB of CPU-side overhead to the host. Anything that may spill is charged in full until load reports its real offload (#230). A loaded model passes `residentBytes`, so the lease still counts toward total capacity but leaves only 256 MiB of scratch pending. Both overhead figures are estimates.

When only upcoming native work is short of memory, the host is not out of memory, so pressure is `constrained` and the store releases the shortfall. The coldest threads go first, then the oldest rows of the newest thread, which is marked for backfill. `critical` from memory actually being exhausted still empties the store. The store reports released bytes, logged as `Context store eviction`.

Verification: `npx vitest run tests/inference-lease-residency.test.ts tests/inference-governor.test.ts tests/context-memory-reservations.test.ts`. These use the real governor and store with injected host memory. Packaged runs, including the 20-turn wipe count, have not been run.
