import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCheckpoint,
  loadCheckpoint,
  readPreimage,
  recordDeleteOp,
  recordWriteOp,
  restoreCheckpoint,
  restoreCheckpointOp,
  snapshotPreimage
} from '../electron/main/services/checkpoints'
import {
  applyUnifiedPatch,
  searchReplaceInFile,
  writeWorkspaceFile,
  WorkspaceFsError
} from '../electron/main/services/workspace-fs'
import { applyCloudPatchFiles } from '../electron/main/services/cloud-agents-client'

// #306 IW-05: undo restores the exact preimage, not a UTF-8 re-encoding of it.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])
// "café = 1" in Latin-1: 0xE9 is not valid UTF-8 on its own.
const LATIN1 = Buffer.from('const caf\xe9 = 1\n', 'latin1')

let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-preimage-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkpoint preimages that are not valid UTF-8 (#306)', () => {
  it('undoes the deletion of a binary file byte for byte', () => {
    const abs = join(root, 'logo.png')
    writeFileSync(abs, PNG)
    const checkpoint = createCheckpoint(root)
    const preimage = readPreimage(abs)
    expect(preimage.base64).toBeDefined()
    unlinkSync(abs)
    recordDeleteOp(root, checkpoint.id, 'logo.png', preimage.text, false, preimage.base64)

    expect(restoreCheckpoint(root, checkpoint.id).restored).toBe(1)
    expect(readFileSync(abs).equals(PNG)).toBe(true)
  })

  it('undoes write_file over a Latin-1 file byte for byte, and only once', () => {
    const abs = join(root, 'legacy.js')
    writeFileSync(abs, LATIN1)
    const checkpoint = createCheckpoint(root)
    const preimage = snapshotPreimage(root, 'legacy.js')!
    writeWorkspaceFile(root, 'legacy.js', 'const cafe = 2\n')
    recordWriteOp(
      root,
      checkpoint.id,
      'legacy.js',
      preimage.text,
      'const cafe = 2\n',
      preimage.base64
    )

    expect(restoreCheckpointOp(root, checkpoint.id, 0).restored).toBe(1)
    expect(readFileSync(abs).equals(LATIN1)).toBe(true)
    // A duplicate undo delivery changes nothing.
    expect(restoreCheckpointOp(root, checkpoint.id, 0).restored).toBe(0)
    expect(readFileSync(abs).equals(LATIN1)).toBe(true)
  })

  it('recognizes an exact preimage already restored by an interrupted undo', () => {
    const abs = join(root, 'logo.png')
    writeFileSync(abs, PNG)
    const checkpoint = createCheckpoint(root)
    const preimage = readPreimage(abs)
    unlinkSync(abs)
    recordDeleteOp(root, checkpoint.id, 'logo.png', preimage.text, false, preimage.base64)
    // The file came back but the receipt was never marked reversed.
    writeFileSync(abs, PNG)
    expect(restoreCheckpoint(root, checkpoint.id).restored).toBe(0)
    expect(readFileSync(abs).equals(PNG)).toBe(true)
  })

  it('persists the exact bytes in the checkpoint record', () => {
    writeFileSync(join(root, 'logo.png'), PNG)
    const checkpoint = createCheckpoint(root)
    const preimage = readPreimage(join(root, 'logo.png'))
    recordDeleteOp(root, checkpoint.id, 'logo.png', preimage.text, false, preimage.base64)
    const op = loadCheckpoint(root, checkpoint.id)!.ops[0]!
    expect(op).toMatchObject({ kind: 'delete', beforeBase64: PNG.toString('base64') })
  })

  it('keeps UTF-8 text receipts unchanged, including a byte-order mark', () => {
    const text = '﻿export const x = "é"\n'
    const abs = join(root, 'bom.ts')
    writeFileSync(abs, text, 'utf8')
    const checkpoint = createCheckpoint(root)
    const preimage = snapshotPreimage(root, 'bom.ts')!
    expect(preimage).toEqual({ text })
    writeWorkspaceFile(root, 'bom.ts', 'export const x = 1\n')
    recordWriteOp(
      root,
      checkpoint.id,
      'bom.ts',
      preimage.text,
      'export const x = 1\n',
      preimage.base64
    )
    expect(loadCheckpoint(root, checkpoint.id)!.ops[0]).not.toHaveProperty('beforeBase64')

    expect(restoreCheckpoint(root, checkpoint.id).restored).toBe(1)
    expect(readFileSync(abs, 'utf8')).toBe(text)
  })
})

describe('text edits on files that are not valid UTF-8 (#306)', () => {
  it('refuses search_replace and leaves every byte in place', () => {
    const abs = join(root, 'legacy.js')
    writeFileSync(abs, LATIN1)
    expect(() => searchReplaceInFile(root, 'legacy.js', '= 1', '= 2')).toThrow(WorkspaceFsError)
    expect(() => searchReplaceInFile(root, 'legacy.js', '= 1', '= 2')).toThrow(/not valid UTF-8/)
    expect(readFileSync(abs).equals(LATIN1)).toBe(true)
  })

  it('refuses apply_patch and leaves every byte in place', () => {
    const abs = join(root, 'legacy.js')
    writeFileSync(abs, LATIN1)
    const patch = [
      '--- a/legacy.js',
      '+++ b/legacy.js',
      '@@ -1 +1 @@',
      '-const caf� = 1',
      '+const cafe = 1',
      ''
    ].join('\n')
    expect(() => applyUnifiedPatch(root, patch)).toThrow(/not valid UTF-8/)
    expect(readFileSync(abs).equals(LATIN1)).toBe(true)
  })

  it('still edits UTF-8 text normally', () => {
    writeFileSync(join(root, 'a.ts'), 'export const café = 1\n', 'utf8')
    searchReplaceInFile(root, 'a.ts', '= 1', '= 2')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('export const café = 2\n')
  })
})

describe('cloud patch apply receipts (#306)', () => {
  const file = (path: string, content: string, before: string | null = null) => ({
    path,
    content,
    before
  })

  it('points each diff at its own checkpoint receipt', () => {
    writeFileSync(join(root, 'b.ts'), 'b0\n')
    writeFileSync(join(root, 'c.ts'), 'c0\n')
    const applied = applyCloudPatchFiles(root, [
      file('a.ts', 'a1\n'),
      file('b.ts', 'b1\n'),
      file('c.ts', 'c1\n')
    ])
    expect(applied.ok).toBe(true)
    const ops = loadCheckpoint(root, applied.checkpointId)!.ops
    for (const diff of applied.diffs) expect(ops[diff.opIndex]).toMatchObject({ path: diff.path })

    // Undoing b restores b, and leaves c applied.
    const b = applied.diffs.find((diff) => diff.path === 'b.ts')!
    restoreCheckpointOp(root, applied.checkpointId, b.opIndex)
    expect(readFileSync(join(root, 'b.ts'), 'utf8')).toBe('b0\n')
    expect(readFileSync(join(root, 'c.ts'), 'utf8')).toBe('c1\n')
  })

  it('refuses the whole bundle, before any write, when a path leaves the workspace', () => {
    const applied = applyCloudPatchFiles(root, [
      file('a.ts', 'a1\n'),
      file('../outside.ts', 'x'),
      file('c.ts', 'c1\n')
    ])
    expect(applied).toMatchObject({ ok: false, checkpointId: '', diffs: [] })
    expect(applied.error).toMatch(/outside the workspace/)
    expect(() => readFileSync(join(root, 'a.ts'))).toThrow()
    expect(() => readFileSync(join(root, 'c.ts'))).toThrow()
  })

  it('applies a file whose name merely contains two dots', () => {
    const applied = applyCloudPatchFiles(root, [file('notes..md', 'n\n')])
    expect(applied.ok).toBe(true)
    expect(applied.diffs.map((diff) => diff.path)).toEqual(['notes..md'])
  })

  it('keeps the checkpoint and applied diffs when a later write fails', () => {
    // A directory where the second file should go makes that write fail.
    writeFileSync(join(root, 'a.ts'), 'a0\n')
    mkdirSync(join(root, 'dir.ts'))
    const applied = applyCloudPatchFiles(root, [file('a.ts', 'a1\n'), file('dir.ts', 'x')])
    expect(applied.ok).toBe(false)
    expect(applied.checkpointId).not.toBe('')
    expect(applied.diffs.map((diff) => diff.path)).toEqual(['a.ts'])
    expect(applied.error).toMatch(/Applied 1 of 2/)
    restoreCheckpointOp(root, applied.checkpointId, applied.diffs[0]!.opIndex)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('a0\n')
  })
})
