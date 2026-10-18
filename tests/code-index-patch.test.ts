import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanWorkspaceIndex, patchWorkspaceIndex } from '../electron/main/services/workspace-index-job'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-index-'))
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'a.ts'), 'export function alpha() { return 1 }\n', 'utf8')
  writeFileSync(join(ws, 'src', 'b.ts'), 'export function beta() { return 2 }\n', 'utf8')
})

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('incremental code index', () => {
  it('patches a single changed file without dropping others', async () => {
    const indexPath = join(ws, '.eris', 'code-index.json')
    const full = await scanWorkspaceIndex(ws, indexPath)
    expect(full.files.sort()).toEqual(['src/a.ts', 'src/b.ts'].sort())
    expect(full.symbols.some((s) => s.name === 'alpha')).toBe(true)

    writeFileSync(
      join(ws, 'src', 'a.ts'),
      'export function alphaRenamed() { return 1 }\n',
      'utf8'
    )
    const patched = await patchWorkspaceIndex(ws, indexPath, ['src/a.ts'])
    expect(patched.files.sort()).toEqual(['src/a.ts', 'src/b.ts'].sort())
    expect(patched.symbols.some((s) => s.name === 'alphaRenamed')).toBe(true)
    expect(patched.symbols.some((s) => s.name === 'beta')).toBe(true)
    expect(patched.fileMeta?.['src/a.ts']).toBeTruthy()

    const disk = JSON.parse(readFileSync(join(ws, '.eris', 'code-index.json'), 'utf8'))
    expect(disk.files).toContain('src/b.ts')
    expect(disk.symbols.some((s: { name: string }) => s.name === 'alphaRenamed')).toBe(true)
  })
})
