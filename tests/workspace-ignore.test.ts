import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  invalidateWorkspaceIgnoreCache,
  shouldSkipDir,
  shouldSkipWorkspacePath
} from '../electron/main/services/workspace-ignore'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'eris-ignore-'))
  invalidateWorkspaceIgnoreCache()
})

afterEach(() => {
  invalidateWorkspaceIgnoreCache()
  try {
    rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('workspace-ignore', () => {
  it('skips default heavy directories', () => {
    expect(shouldSkipDir(ws, 'node_modules', 'node_modules')).toBe(true)
    expect(shouldSkipDir(ws, 'dist', 'packages/app/dist')).toBe(true)
    expect(shouldSkipDir(ws, 'src', 'src')).toBe(false)
  })

  it('honors .gitignore and .erisignore', () => {
    writeFileSync(join(ws, '.gitignore'), 'vendor/\n*.log\n!keep.log\n', 'utf8')
    writeFileSync(join(ws, '.erisignore'), 'tmp/**\n', 'utf8')
    invalidateWorkspaceIgnoreCache(ws)
    expect(shouldSkipWorkspacePath(ws, 'vendor/lib.js', false)).toBe(true)
    expect(shouldSkipWorkspacePath(ws, 'notes.log', false)).toBe(true)
    expect(shouldSkipWorkspacePath(ws, 'tmp/cache/x.ts', false)).toBe(true)
    expect(shouldSkipWorkspacePath(ws, 'src/app.ts', false)).toBe(false)
  })
})
