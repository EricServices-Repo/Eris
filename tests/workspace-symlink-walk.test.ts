import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force the in-process scan: rg does not follow links, and the scan must match it.
const rg = vi.hoisted(() => ({ available: false }))
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (!rg.available && args[0] === 'rg') {
        const child = actual.spawn('/nonexistent-rg-for-test', [])
        return child
      }
      return actual.spawn(...args)
    }
  }
})

import { buildCodeIndex } from '../electron/main/services/code-index'
import { workspaceTree } from '../electron/main/services/workspace-fs'
import {
  invalidateWorkspaceSearchCache,
  workspaceGlob,
  workspaceGrep
} from '../electron/main/services/workspace-search'

/**
 * #306 IW-03: read_file already refuses a path whose real location is outside the
 * workspace. Directory walkers must not reach the same bytes by following a link.
 */
describe('workspace walkers do not follow symlinks out of the workspace (#306)', () => {
  let base: string
  let ws: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'eris-symlink-')))
    ws = join(base, 'ws')
    const outside = join(base, 'outside')
    mkdirSync(join(ws, 'src'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(ws, 'src', 'inside.ts'), 'export function insideFn() { return "MARKER" }\n')
    writeFileSync(
      join(outside, 'secret.ts'),
      'export function leakedSecret() { return "MARKER-OUTSIDE" }\n'
    )
    symlinkSync(outside, join(ws, 'linked-dir'))
    symlinkSync(join(outside, 'secret.ts'), join(ws, 'src', 'linked-file.ts'))
    invalidateWorkspaceSearchCache(ws)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('grep finds workspace text but no outside content', async () => {
    const result = await workspaceGrep(ws, 'MARKER')
    expect(result.detail).toContain('(scan)')
    expect(result.hits.map((hit) => hit.path)).toEqual(['src/inside.ts'])
    expect(result.detail).not.toContain('MARKER-OUTSIDE')
  })

  it('glob lists no file reached through a link', () => {
    const { paths } = workspaceGlob(ws, '**/*.ts')
    expect(paths).toEqual(['src/inside.ts'])
  })

  it('tree shows links as entries without walking into them', () => {
    const tree = workspaceTree(ws, '.', 4)
    expect(tree).toContain('linked-dir@')
    expect(tree).toContain('linked-file.ts@')
    expect(tree).not.toContain('secret.ts')
  })

  it('the code index holds no symbol from outside the workspace', () => {
    const index = buildCodeIndex(ws)
    expect(index.symbols.map((symbol) => symbol.name)).toContain('insideFn')
    expect(index.symbols.map((symbol) => symbol.name)).not.toContain('leakedSecret')
    expect(index.files).toEqual(['src/inside.ts'])
  })
})
