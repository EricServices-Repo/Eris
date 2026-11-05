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
