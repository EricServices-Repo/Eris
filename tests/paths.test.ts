import { describe, expect, it } from 'vitest'
import { isAbsPath, joinWorkspacePath, pathBasename } from '../src/shared/paths'

describe('shared paths', () => {
  it('detects absolute paths on posix and windows', () => {
    expect(isAbsPath('/Users/a/b')).toBe(true)
    expect(isAbsPath('C:\\Users\\a')).toBe(true)
    expect(isAbsPath('C:/Users/a')).toBe(true)
    expect(isAbsPath('\\\\server\\share')).toBe(true)
    expect(isAbsPath('rel/file.ts')).toBe(false)
  })

  it('basenames mixed separators', () => {
    expect(pathBasename('src/foo/bar.ts')).toBe('bar.ts')
    expect(pathBasename('src\\foo\\bar.ts')).toBe('bar.ts')
  })

  it('joins workspace roots with the correct separator', () => {
    expect(joinWorkspacePath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinWorkspacePath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts')
    expect(joinWorkspacePath('/repo', '/abs/file.ts')).toBe('/abs/file.ts')
    expect(joinWorkspacePath('/repo', 'src/a.ts → old')).toBe('/repo/src/a.ts')
  })
})
