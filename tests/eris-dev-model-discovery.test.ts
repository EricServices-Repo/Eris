import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as paths from '../electron/main/services/paths'
import { devModels } from '../electron/dev/models'
import {
  deleteBuiltinModel,
  downloadBuiltinModel,
  localModelPath,
  verifyBuiltinModel
} from '../electron/main/services/builtin-model'
import {
  deleteLocalModel,
  downloadLocalModel,
  findLocalEntry,
  localModelFilePath
} from '../electron/main/services/local-model'

let root: string
const builtin = {
  id: 'fixture',
  ref: 'builtin:fixture',
  name: 'fixture',
  filename: 'fixture.gguf',
  approxBytes: 64,
  role: 'composer',
  tier: 'lite'
}
const local = {
  ...builtin,
  id: 'hf-fixture',
  ref: 'local:hf-fixture',
  filename: 'hub.gguf',
  family: 'Hugging Face'
}
const shared = (kind: string, name: string) => join(root, 'Eris', 'models', kind, name)
const own = (kind: string, name: string) => join(root, 'Eris-Dev', 'models', kind, name)
function gguf(path: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  const bytes = Buffer.alloc(64)
  bytes.write('GGUF')
  bytes.writeUInt32LE(3, 4)
  writeFileSync(path, bytes)
}
function catalog(entries: unknown[]) {
  writeFileSync(shared('local', 'catalog-extra.json'), JSON.stringify({ localModels: entries }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eris-model-discovery-'))
  vi.stubEnv('ERIS_TEST_APPDATA', root)
  vi.spyOn(app, 'getName').mockReturnValue('Eris-Dev')
  const manifest = join(root, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ builtinModels: [builtin], localModels: [] }))
  vi.spyOn(paths, 'modelsManifestPath').mockReturnValue(manifest)
  gguf(shared('builtin', builtin.filename))
  gguf(shared('local', local.filename))
  catalog([local])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('Eris-Dev shared model discovery without symlink privileges', () => {
  it('lists shared Composer and Hub downloads and resolves the same files for inference', async () => {
    expect((await devModels()).map((model) => model.id)).toEqual(
      expect.arrayContaining([builtin.ref, local.ref])
    )
    expect(localModelPath(builtin as never)).toBe(shared('builtin', builtin.filename))
    expect(localModelFilePath(findLocalEntry(local.ref)!)).toBe(shared('local', local.filename))
    expect(readdirSync(join(root, 'Eris-Dev', 'models', 'builtin'))).toEqual([])
    expect(readdirSync(join(root, 'Eris-Dev', 'models', 'local'))).toEqual([])
  })

  it('prefers debug-app downloads but never exposes them to production Eris', async () => {
    gguf(own('local', local.filename))
    expect(localModelFilePath(findLocalEntry(local.ref)!)).toBe(own('local', local.filename))
    vi.spyOn(app, 'getName').mockReturnValue('Eris')
    expect(localModelFilePath(findLocalEntry(local.ref)!)).toBe(shared('local', local.filename))
    expect(paths.modelReadDirs('local')).toEqual([join(root, 'Eris', 'models', 'local')])
  })

  it('refreshes Hub metadata and readiness after Eris adds or removes models', async () => {
    expect((await devModels()).some((model) => model.id === local.ref)).toBe(true)
    const added = { ...local, id: 'hf-second', ref: 'local:hf-second', filename: 'second.gguf' }
    gguf(shared('local', added.filename))
    catalog([local, added])
    expect((await devModels()).some((model) => model.id === added.ref)).toBe(true)
    unlinkSync(shared('local', added.filename))
    expect((await devModels()).some((model) => model.id === added.ref)).toBe(false)
  })

  it('does not delete borrowed model files or metadata', () => {
    const originalCatalog = readFileSync(shared('local', 'catalog-extra.json'), 'utf8')
    deleteLocalModel(local.id)
    deleteBuiltinModel(builtin.id)
    expect(existsSync(shared('local', local.filename))).toBe(true)
    expect(existsSync(shared('builtin', builtin.filename))).toBe(true)
    expect(readFileSync(shared('local', 'catalog-extra.json'), 'utf8')).toBe(originalCatalog)
    expect(paths.isSharedModelPath(own('local', local.filename))).toBe(false)
    expect(paths.isSharedModelPath(shared('local', local.filename))).toBe(true)
  })

  it('reuses valid shared downloads without starting another download', async () => {
    expect((await downloadLocalModel(local.id)).ready).toBe(true)
    expect((await downloadBuiltinModel(builtin.id)).ready).toBe(true)
    expect(existsSync(own('local', local.filename))).toBe(false)
    expect(existsSync(own('builtin', builtin.filename))).toBe(false)
  })

  it('verifies borrowed weights without writing a sidecar into Eris', async () => {
    expect((await verifyBuiltinModel(builtin.id)).ok).toBe(true)
    expect(existsSync(shared('builtin', `${builtin.filename}.sha256`))).toBe(false)
  })

  it('reports borrowed corruption without deleting the Eris file', async () => {
    writeFileSync(shared('builtin', builtin.filename), Buffer.alloc(64))
    expect(await verifyBuiltinModel(builtin.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Repair it in Eris')
    })
    expect(existsSync(shared('builtin', builtin.filename))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'replaces an old catalog symlink before editing local metadata',
    () => {
      mkdirSync(join(root, 'Eris-Dev', 'models', 'local'), { recursive: true })
      symlinkSync(shared('local', 'catalog-extra.json'), own('local', 'catalog-extra.json'))
      const original = readFileSync(shared('local', 'catalog-extra.json'), 'utf8')
      deleteLocalModel(local.id)
      expect(readFileSync(shared('local', 'catalog-extra.json'), 'utf8')).toBe(original)
      expect(
        JSON.parse(readFileSync(own('local', 'catalog-extra.json'), 'utf8')).localModels
      ).toEqual([])
    }
  )
})
