# #125 — recheck recalled memory at model dispatch

Recalled text used to stay in the retained system prompt for the whole run, and nothing compared it with current controls after selection. An exclusion, deletion or rewrite made during a run therefore did not stop later requests from carrying the old text.

`streamModelChat`, the single transport entry point, now passes outbound messages through `withEligibleMemory`. Each chat request leases its recalled items, and every route (worker turns, retries, compaction, recovery, final review, diagnostics adapters) gets the same check. Retained prompts are never edited: removal happens on a copy at dispatch, so a later recompile or compaction goes through the same removal and cannot revive an item. The last eligibility check is synchronous, so nothing can interleave before the transport call.

The small epoch vector is a per-namespace revocation token. It changes when controls are saved, a conversation is rewritten or deleted, or a namespace is disabled. Cache-only events (memory-pressure trim, idle expiry, LRU eviction, chunked-append reconstruction) do not change it, so evidence stays usable when nothing about its eligibility changed. The token is captured inside `select()`, which closes the gap between selection and lease registration.

When the token changes, each item is rechecked against the current snapshot:

- Forgotten sources, cutoffs and removed pins are dropped individually, and unrelated items stay.
- A cleared snapshot is reloaded once within `foregroundDeadlineMs`, so a rewrite that kept a source does not lose it. If reload fails or the source is gone, the item is dropped (fail closed).
- Revocation is sticky for the lease.

Policy is re-read at dispatch too. Disabling recall drops all leased items for the run, and turning off remote sharing blocks every later remote request for that run, even if sharing is turned back on. Remote-without-opt-in is enforced per destination, so a reroute to a remote backend cannot carry items that a local backend may still receive.

A live local GGUF session holds its seeded prompt, so the first revoking dispatch releases the session and forces a reseed. Revoked IDs and the remaining count are recorded as a `memory-revoked` task event, with no raw text.

Limits:

- Requests already sent cannot be recalled.
- Removal matches rendered item text. If a model already paraphrased an excerpt into its own output or a compaction summary before revocation, that derived text is not found here. Lineage through generated state is #126.
- A compiler cut inside an item's marker can leave a marker fragment (kind and digest prefix). It contains no excerpt text.
- The window between the durable control commit and `setControls` is not covered, but the user is not told the exclusion succeeded until after that point.

Validation: `npx vitest run tests/memory-dispatch.test.ts`. Scripted transport capture through the real `streamModelChat`, chat database and store, covering exclusion after selection, the pre-lease race, cutoffs, unrelated edits, compiler truncation, deletion, rewrite during compilation, compaction, eviction, lease release, GGUF reseed, remote destination and mid-run policy changes. No packaged, live-model or hardware run.
