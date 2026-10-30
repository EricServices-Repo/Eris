# #149 — registered memory namespaces and database incarnation

Memory keys now hash the profile root, canonical workspace root, main-owned registered workspace ID and thread ID. The ID comes only from profile `state.json`, so `.eris` metadata in a copied project cannot assert one. Removing and re-registering a folder gives it a new namespace, and text warmed under the old registration is unreachable from then on (it stays in RAM until idle expiry or eviction, with no handle that can read it).

Source epochs now carry the physical identity of `chats.sqlite` (device, inode, birth time) ahead of the stored per-thread epoch. Thread IDs, epochs and revisions all travel with a copy, so only the file can separate a replacement from the database a snapshot was read from. Because hydration, appends, control writes and inspector leases already compare `sourceEpoch`, a replaced database invalidates all of them without a new check at each site.

The worker's cached handle now notices a replaced file on its next request and reopens it, instead of reading from and writing to an unlinked inode. SQLite will not checkpoint a moved database on close, and it would replay the abandoned WAL onto the new file, so the old transcript came back through the journal. `retire()` removes that WAL and its `-shm` only if the WAL is the file this handle owned. A journal delivered with the replacement is left alone.

Defined behavior:

- **Aliases:** symlinks to one folder share a namespace. If several registrations resolve to the same folder, the oldest record owns it.
- **Moves:** the registration keeps its ID but the canonical root changes, so the namespace changes and the next turn rehydrates from SQLite. Nothing crosses a path change in RAM.
- **Backup restore:** a restored file is a new incarnation. Recall rehydrates, and open inspector handles report stale.
- **Unregistered roots:** a root with no registration uses a null ID, so its key still separates it from any registered incarnation.

Known limit: overwriting `chats.sqlite` in place, keeping its inode and birth time, is not detectable this way. It is also unsafe for any open SQLite handle.

Validation: `npx vitest run tests/context-memory-identity.test.ts`. Scripted coverage of re-registration, symlink aliases, asserted metadata, profile separation, diverged copies with matching epochs, handle reopen, WAL replay and stale control edits. Deterministic Node checks only; no packaged, live-model or hardware run. The two tests that replace a database under an open handle are POSIX-only, because Windows refuses to remove an open file, which also means that scenario cannot occur there. Handle-closed replacement runs on Windows in CI.
