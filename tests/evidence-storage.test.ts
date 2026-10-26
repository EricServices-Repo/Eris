import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  utimesSync,
  symlinkSync
} from 'fs'
import * as fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  atomicEvidenceJson,
  pinEvidence,
  readEvidence,
  saveEvidenceOwner,
  ownerKey,
  storageFailures
} from '../electron/main/services/evidence-records'
import {
  cleanupEvidence,
  deleteThreadEvidence,
  backupEvidence,
  restoreEvidence,
  evidenceStores
} from '../electron/main/services/evidence-lifecycle'
import { userDataRoot } from '../electron/main/services/paths'
import { parsePersistedTask, CheckpointSchema } from '../electron/main/services/evidence-schemas'
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eris-storage-'))
  rmSync(userDataRoot(), { recursive: true, force: true })
  mkdirSync(userDataRoot(), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
// Restore the actual writer for every case; injected failures are single-call only.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
})
const store = (id: string) => evidenceStores(root).find((s) => s.id === id)!.root
function put(id: string, name: string, value: unknown) {
  const path = join(store(id), name)
  atomicEvidenceJson(path, value)
  return path
}
describe('private evidence lifecycle', () => {
  it('quarantines torn and invalid checkpoint metadata without losing the original', () => {
    const path = join(root, 'record.json')
    writeFileSync(path, '{"ops":[')
    expect(readEvidence(path, (v) => CheckpointSchema.parse(v))).toBeNull()
    const quarantined = readdirSync(root).find((n) => n.includes('.corrupt-'))!
    expect(readFileSync(join(root, quarantined), 'utf8')).toBe('{"ops":[')
    expect(storageFailures().some((x) => x.path === path)).toBe(true)
    expect(() => parsePersistedTask({ version: 2, authority: { edit: true } })).toThrow()
  })
  it('keeps a previous durable record when a new write fails with disk full', () => {
    const path = join(root, 'record.json')
    atomicEvidenceJson(path, { old: true })
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC')
    })
    expect(() => atomicEvidenceJson(path, { old: false })).toThrow('ENOSPC')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ old: true })
    expect(readdirSync(root)).toEqual(['record.json'])
  })
  it('pins active evidence against cleanup, deletion, backup and restore', () => {
    const release = pinEvidence()
    try {
      for (const run of [
        () => cleanupEvidence(root),
        () => deleteThreadEvidence(root, 'a'),
        () => backupEvidence(root),
        () => restoreEvidence(root, {})
      ])
        expect(run).toThrow(/active|Active/)
    } finally {
      release()
      release()
    }
    expect(() => backupEvidence(root)).not.toThrow()
  })
  it('deletes only exact conversation owners and their linked checkpoint and ledger', () => {
    for (const id of ['a', 'b']) {
      saveEvidenceOwner({
        version: 1,
        taskId: id,
        threadId: id,
        root,
        terminal: true,
        checkpointId: id === 'a' ? '11111111-1111-4111-8111-111111111111' : undefined
      })
      put('ledger', ownerKey(id) + '.jsonl', { taskId: id })
    }
    const checkpoint = join(store('checkpoints'), '11111111-1111-4111-8111-111111111111')
    mkdirSync(checkpoint, { recursive: true })
    writeFileSync(join(checkpoint, 'meta.json'), '{}')
    const secret = join(userDataRoot(), 'settings.json')
    writeFileSync(secret, 'credential')
    const model = put('models', 'keep.gguf', { weight: true })
    deleteThreadEvidence(root, 'a')
    expect(existsSync(join(store('ledger'), ownerKey('a') + '.jsonl'))).toBe(false)
    expect(existsSync(checkpoint)).toBe(false)
    expect(existsSync(join(store('ledger'), ownerKey('b') + '.jsonl'))).toBe(true)
    expect(readFileSync(secret, 'utf8')).toBe('credential')
    expect(existsSync(model)).toBe(true)
  })
  it('retains unresolved evidence and prunes only old terminal groups', () => {
    const done = put('diagnostics', 'done.summary.json', { status: 'completed' })
    const companion = put('diagnostics', 'done.cases.jsonl', { x: true })
    const active = put('diagnostics', 'active.summary.json', { status: 'running' })
    for (const path of [done, companion, active]) utimesSync(path, 1, 1)
    expect(cleanupEvidence(root).removed).toBe(1)
    expect(existsSync(done)).toBe(false)
    expect(existsSync(companion)).toBe(false)
    expect(existsSync(active)).toBe(true)
  })
  it('validates all restore entries before writes and preserves existing conflicts', () => {
    put('contracts', 'one.json', { value: 1 })
    const backup = backupEvidence(root)
    expect(restoreEvidence(root, backup).conflicts).toContain('one.json')
    const bytes = Buffer.from('{}')
    const bad = {
      store: 'contracts',
      path: '../../escape.json',
      bytes: bytes.toString('base64'),
      digest: createHash('sha256').update(bytes).digest('hex')
    }
    expect(() =>
      restoreEvidence(root, { ...backup, files: [{ ...bad, path: 'new.json' }, bad] })
    ).toThrow(/escapes/)
    expect(existsSync(join(store('contracts'), 'new.json'))).toBe(false)
    expect(() =>
      restoreEvidence(root, {
        ...backup,
        files: [{ ...bad, path: 'new.json', digest: '0'.repeat(64) }]
      })
    ).toThrow(/integrity/)
  })
  it('refuses linked backup destinations', () => {
    const outside = mkdtempSync(join(tmpdir(), 'eris-outside-'))
    try {
      mkdirSync(store('contracts'), { recursive: true })
      symlinkSync(
        outside,
        join(store('contracts'), 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const bytes = Buffer.from('{}')
      expect(() =>
        restoreEvidence(root, {
          version: 1,
          workspace: root,
          files: [
            {
              store: 'contracts',
              path: 'linked/escape.json',
              bytes: bytes.toString('base64'),
              digest: createHash('sha256').update(bytes).digest('hex')
            }
          ]
        })
      ).toThrow(/Linked/)
      expect(existsSync(join(outside, 'escape.json'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
