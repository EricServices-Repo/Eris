# #122 — bounded recall projection, independent of rendering metadata

SQLite now constructs a normalized recall projection inside the workspace worker rather than transferring the complete canonical JSON into JavaScript. Thinking, assets and unrelated rendering fields are never selected. Identity/role/model fields and optional receipt bytes are bounded before transfer; oversized optional receipts are omitted with explicit partial coverage. Old valid rows without timestamps remain supported; malformed rows retain corruption diagnostics.

Large text is split into at most 32,768 Unicode code-point chunks, with a continuation cursor (ordinal plus content offset). Page byte limits remain enforced and workers fetch one page at a time. Hydration carries the cursor, marks unfinished bounded loads partial and resumes capacity backfill from the oldest retained chunk. Source IDs stay canonical, while fact IDs include chunk offsets. Retained-message counts use distinct ordinals rather than inflating counts with chunks. Canonical SQLite transcript/rendering metadata is unchanged. Appending to a chunked snapshot invalidates and reloads it rather than merging incompatible whole-message/chunk units.

SQL JSON parsing can still allocate native worker memory proportional to the canonical row; this change bounds decoded JS/IPC content, not a hard process RSS ceiling. Hydration remains subject to existing byte/message/page/deadline limits; searchable evicted archive coverage remains #134.

Validation: `npx vitest run tests/chat-database.test.ts tests/context-memory-recovery.test.ts tests/context-memory.test.ts tests/context-sequence.test.ts` covers 2MB traces, image metadata, escaped Unicode reconstruction, bounded page payloads, old-schema/corrupt rows and real worker recall of an older chunk. Deterministic fixtures; no live inference or hardware claims.

`node scripts/check-client-workers.mjs` additionally sends a trace-heavy Unicode source through the built workspace worker, follows content cursors and reconstructs every chunk without trace text.
