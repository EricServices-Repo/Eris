import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs'
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
