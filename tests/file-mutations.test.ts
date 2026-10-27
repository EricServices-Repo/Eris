import { afterEach, describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  prepareMutationPlan,
  publishWorkspaceText,
  mutationRecovery
} from '../electron/main/services/file-mutations'
import { executeTool } from '../electron/main/services/agent/execute-tool'
import { renameWorkspacePath, deleteWorkspacePath } from '../electron/main/services/workspace-fs'
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})
const actualFs = await vi.importActual<typeof import('fs')>('fs')
const roots: string[] = []
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'eris-publication-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync)
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
describe('journaled file publication', () => {
  it('preserves an external save between authorization and execution', () => {
    const root = fixture()
    fs.writeFileSync(join(root, 'a.ts'), 'before')
    const plan = prepareMutationPlan(root, ['a.ts'])
    fs.writeFileSync(join(root, 'a.ts'), 'external save')
    const result = executeTool(
      root,
      { name: 'write_file', args: { path: 'a.ts', content: 'agent' }, raw: '' },
      plan
    )
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external save')
  })
  it.each([false, true])(
    'rechecks immediately after staging, including concurrent create=%s',
    (missing) => {
      const root = fixture()
      if (!missing) fs.writeFileSync(join(root, 'a.ts'), 'before')
      const original = actualFs.writeFileSync
      vi.mocked(fs.writeFileSync).mockImplementation(((
        file: unknown,
        data: unknown,
        ...args: unknown[]
      ) => {
        const value = Reflect.apply(original, fs, [file, data, ...args])
        if (data === 'agent-result') original(join(root, 'a.ts'), 'external save')
        return value
      }) as typeof fs.writeFileSync)
      expect(() => publishWorkspaceText(root, 'a.ts', 'agent-result')).toThrow(
        /changed before publication/
      )
      expect(fs.readFileSync(join(root, 'a.ts'), 'utf8')).toBe('external save')
      expect(mutationRecovery(root)[0]?.state).toBe('conflicted')
    }
  )
  it('reports an applied effect truthfully when final receipt persistence fails', () => {
    const root = fixture()
    fs.writeFileSync(join(root, 'a.ts'), 'before')
    const original = actualFs.writeFileSync
    vi.mocked(fs.writeFileSync).mockImplementation(((
      file: unknown,
      data: unknown,
      ...args: unknown[]
    ) => {
      if (
        typeof data === 'string' &&
        data.startsWith('{') &&
        ['applied', 'partial'].includes(JSON.parse(data).state)
      )
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return Reflect.apply(original, fs, [file, data, ...args])
    }) as typeof fs.writeFileSync)
    const result = executeTool(root, {
      name: 'write_file',
      args: { path: 'a.ts', content: 'complete text' },
      raw: ''
    })
    expect(result).toMatchObject({ ok: false, mutated: true })
    expect(fs.readFileSync(join(root, 'a.ts'), 'utf8')).toBe('complete text')
    expect(mutationRecovery(root)[0]?.state).toBe('prepared')
    const record = JSON.parse(
      fs.readFileSync(
        join(root, '.eris/transactions', fs.readdirSync(join(root, '.eris/transactions'))[0]!),
        'utf8'
      )
    )
    expect(Buffer.from(record.before['a.ts'], 'base64').toString()).toBe('before')
  })
  it('records applied files individually and refuses stale rename destinations', () => {
    const root = fixture()
    publishWorkspaceText(root, 'one.ts', 'one')
    fs.writeFileSync(join(root, 'two.ts'), 'two')
    const plan = prepareMutationPlan(root, ['two.ts', 'target.ts'])
    fs.writeFileSync(join(root, 'target.ts'), 'user file')
    expect(() => renameWorkspacePath(root, 'two.ts', 'target.ts', plan)).toThrow()
    expect(mutationRecovery(root).filter((row) => row.state === 'applied')).toHaveLength(1)
    expect(fs.readFileSync(join(root, 'two.ts'), 'utf8')).toBe('two')
    expect(fs.readFileSync(join(root, 'target.ts'), 'utf8')).toBe('user file')
  })
  it('rejects dangling symlinks and irreversible nonempty directory deletion', () => {
    const root = fixture()
    fs.symlinkSync(join(root, 'missing'), join(root, 'alias'))
    expect(() => publishWorkspaceText(root, 'alias', 'agent')).toThrow(/Symlink/)
    fs.mkdirSync(join(root, 'folder'))
    fs.writeFileSync(join(root, 'folder/user.ts'), 'retain')
    expect(() => deleteWorkspacePath(root, 'folder')).toThrow()
    expect(fs.readFileSync(join(root, 'folder/user.ts'), 'utf8')).toBe('retain')
  })
})
