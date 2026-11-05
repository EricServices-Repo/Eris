# #306 — Undo restores exact bytes; text edits refuse non-UTF-8 files

The issue's IW-05 requires preimages captured before destructive effects, and a
revert that preserves the user's work.

## Defect

Checkpoint preimages were read as UTF-8 strings (`readFileSync(path, 'utf8')`) and
written back as UTF-8 on undo. For a file that is not valid UTF-8, decoding replaces
each undecodable byte with U+FFFD, so the stored preimage was already wrong:

- **`delete_path` on a binary file** (an image, a font, a compiled asset): undo
  recreated the file with the wrong bytes.
- **`write_file` over a Latin-1 or other non-UTF-8 file:** undo wrote back the
  mangled text.

In both cases Undo reported success.

`search_replace` and `apply_patch` had the same problem before any undo. They
decoded the whole file, changed one span and wrote the whole file back. Every
non-ASCII byte outside the edit was replaced.

## Change

- `readPreimage` / `snapshotPreimage` (in `checkpoints.ts`) decode with a strict
  UTF-8 decoder. Valid text, including a byte-order mark, is recorded exactly as
  before. For anything else the receipt also stores `beforeBase64`, the exact bytes.
  `before` stays as a display copy for diffs.
- Write and delete receipts accept the optional `beforeBase64` (schema updated).
  Undo writes those bytes, and the idempotency checks for interrupted or duplicate
  undo compare against their digest. Receipts without the field behave as before.
- The agent loop's `write_file`/`search_replace`/`apply_patch`/`notebook_edit` and
  `delete_path` branches, and Cloud patch apply, pass the exact preimage.
- `search_replace` and `apply_patch` refuse a file that is not valid UTF-8 and leave
  it untouched. The error tells the model to leave the file alone or replace it
  whole with `write_file`, which undo can now reverse exactly.

## Tests

`tests/checkpoint-exact-preimage.test.ts` (in the `agents` qualification profile)
covers:

- binary delete undo
- Latin-1 `write_file` undo and a duplicate undo
- an interrupted undo whose bytes were already restored
- persistence of `beforeBase64`
- unchanged UTF-8/BOM receipts
- both text-edit refusals

The binary, Latin-1, interrupted-undo, persistence and refusal cases fail against
the previous code.

## Limits

- Receipts still hold preimages inline in `meta.json`, which `loadCheckpoint` reads
  with a 64 MB bound. A very large deleted file can make a checkpoint unreadable, as
  it already could for large text files. Moving preimages to content-addressed blobs
  is separate work.
- Rename receipts are unchanged. Undoing a rename moves the file back without
  rewriting its content.

## Cloud patch apply receipts

`applyCloudJobArtifacts` had three further receipt defects. The apply step is now
`applyCloudPatchFiles` (exported for tests).

- **Wrong-file undo.** Each diff carried its index in the bundle as `opIndex`, not
  the index of its checkpoint receipt. A skipped path shifted every later diff, so
  undoing one file in Diff Review reversed a different file, or failed with "op not
  found".
- **Silent partial apply.** Paths that were empty or contained `..` were skipped
  with `continue`, and the result still said `ok: true`. The substring test also
  skipped legitimate names such as `notes..md`. Now every path is checked with
  `resolveInWorkspace` before the first write. One unusable path refuses the whole
  bundle and nothing is written. Authorization, the stale check and the write all
  use the same normalized path.
- **Undo lost after a mid-apply failure.** When a later write threw, the result had
  no checkpoint and no diffs, though earlier files were already on disk. The result
  now keeps the checkpoint and the applied diffs and says how many of the total were
  applied. Inline Cloud runs emit those diffs before raising the error. The Agents
  Inbox shows an `ok: false` result as an error instead of treating it as success.

Three cases in `tests/checkpoint-exact-preimage.test.ts` fail against the previous
loop: the escape refusal, `notes..md`, and the kept receipts. The receipt-index case
guards the fix; the old mis-indexing appeared only after a skip, which no longer
happens.

Applying a bundle without a task (Agents Inbox) still skips the stale-base check,
because older Cloud servers may not send `before`. That check is not changed here.
