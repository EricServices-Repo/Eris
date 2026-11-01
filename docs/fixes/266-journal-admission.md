# #266 — Admit journal memory before allocating it

`RunJournal.append` ran `Buffer.from(content)` before checking the 32 MiB cap or taking a reservation, so an entry that was about to be refused had already allocated a full encoded copy. `read` ran `Buffer.concat(...).toString()` with no reservation. The ledger could stay inside its limits while real memory did not.

- **Append order:** size comes from `Buffer.byteLength`, which allocates nothing. The digest hashes 256 Ki character slices. Only after a reservation succeeds is the text encoded, straight into the chunks that are kept, so there is no intermediate full copy.
- **Failed allocation:** the reservation is released and the entry stays with `memory-pressure`, so the tool result and the run are unaffected.
- **Reads:** decoding is charged to the ledger at twice the stored bytes, the worst case for a JS string, and released in `finally`. Chunks are decoded in place rather than concatenated.
- **Search:** holds its scratch for the decoded, redacted and lowercased copies together, at six times the stored bytes.
- **New `busy` read status:** when the scratch is refused, the entry is still held and a later read can succeed. `context_read` returns a marker saying so, and search still matches on metadata. This is distinct from `omitted`, where the content is gone.

Chunks can now end up to three bytes short of 1 MiB, because a character is never split across chunks. Total bytes, digests and read-back are unchanged, and tests cover pairs across slice and chunk edges and lone surrogates.

## Known limits

- `context_read` still redacts and slices the returned string after the read's scratch is released, so that copy is not charged. It is short-lived and bounded by the entry.
- Peak is measured through reservation sizes and call order, not process memory. No host was exhausted on purpose.
- The source string is already resident when `append` is called. This fix bounds what the journal adds to it.

Verification: `npx vitest run tests/run-journal.test.ts tests/context-pull.test.ts`.
