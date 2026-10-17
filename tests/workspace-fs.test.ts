import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  isPathInside,
  readWorkspaceFile,
  resolveInWorkspace,
  toWorkspaceRelative,
  WorkspaceFsError
} from '../electron/main/services/workspace-fs'

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-ws-')))
})

describe('resolveInWorkspace', () => {
  it('resolves relative paths inside the workspace', () => {
    expect(resolveInWorkspace(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'))
    expect(resolveInWorkspace(root, '')).toBe(root)
    expect(resolveInWorkspace(root, './src/../b.ts')).toBe(join(root, 'b.ts'))
  })

  it.each(['../outside.txt', '../../etc/passwd', '/etc/passwd', 'src/../../x'])(
    'rejects escape %s',
    (p) => {
      expect(() => resolveInWorkspace(root, p)).toThrow(WorkspaceFsError)
    }
  )

  it('accepts absolute paths that are inside the workspace', () => {
    expect(resolveInWorkspace(root, join(root, 'deep/file.md'))).toBe(join(root, 'deep/file.md'))
  })

  it('rejects a missing workspace', () => {
    expect(() => resolveInWorkspace(join(root, 'nope'), 'a')).toThrow(/does not exist/)
  })

  it('reads a project file when the path repeats the workspace folder name', () => {
    const rel = '.eris/rules/README.md'
    mkdirSync(join(root, '.eris/rules'), { recursive: true })
    writeFileSync(join(root, rel), 'rules\n', 'utf8')
    const prefixed = `${basename(root)}/${rel}`
    expect(resolveInWorkspace(root, prefixed)).toBe(join(root, rel))
    expect(readWorkspaceFile(root, prefixed).content).toBe('rules\n')
    expect(resolveInWorkspace(root, `${basename(root)}/${basename(root)}/${rel}`)).toBe(
      join(root, rel)
    )
  })

  it('keeps a real child folder that has the same name as the workspace', () => {
    const name = basename(root)
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'keep.txt'), 'nested\n', 'utf8')
    expect(resolveInWorkspace(root, `${name}/keep.txt`)).toBe(join(root, name, 'keep.txt'))
    expect(readWorkspaceFile(root, `${name}/keep.txt`).content).toBe('nested\n')
  })
})

describe('symlink escapes', () => {
  let outside = ''
  beforeAll(() => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'eris-outside-')))
    mkdirSync(join(root, 'real'), { recursive: true })
    symlinkSync(outside, join(root, 'escape'))
    symlinkSync(join(root, 'real'), join(root, 'inner-link'))
  })

  it('rejects paths that leave the workspace through a symlink', () => {
    expect(() => resolveInWorkspace(root, 'escape/secret.txt')).toThrow(WorkspaceFsError)
    expect(isPathInside(root, join(root, 'escape', 'new-file.txt'))).toBe(false)
  })

  it('allows symlinks that stay inside the workspace', () => {
    expect(isPathInside(root, join(root, 'inner-link', 'x.ts'))).toBe(true)
    expect(() => resolveInWorkspace(root, 'inner-link/x.ts')).not.toThrow()
  })

  it('treats the workspace root as inside and siblings as outside', () => {
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, `${root}-sibling/a`)).toBe(false)
  })
})

describe('toWorkspaceRelative', () => {
  it('returns posix-style relative paths', () => {
    expect(toWorkspaceRelative(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(toWorkspaceRelative(root, root)).toBe('.')
  })
})
