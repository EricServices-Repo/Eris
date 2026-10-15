import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  confirmProjectMemory,
  projectMemoryMode,
  rememberAgentRun,
  rememberAskUserReply,
  undoLastProjectMemory
} from '../electron/main/services/project-memory'
import { getWorkspaceContext } from '../electron/main/services/workspace-context'
import type { AppSettings } from '../src/shared/settings-schema'

function settings(mode: 'auto' | 'ask' | 'off'): AppSettings {
  return {
    agent: { projectMemory: mode }
  } as AppSettings
}

describe('project memory', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0
  })

  function ws(): string {
    const d = mkdtempSync(join(tmpdir(), 'eris-mem-'))
    dirs.push(d)
    return d
  }

  it('defaults to auto', () => {
    expect(projectMemoryMode(undefined)).toBe('auto')
    expect(projectMemoryMode({ agent: {} } as AppSettings)).toBe('auto')
  })

  it('appends a note after a successful agent run (auto)', () => {
    const root = ws()
    const result = rememberAgentRun(root, settings('auto'), {
      goal: 'Improve the calculator UI',
      filesTouched: ['src/App.tsx', 'src/Calc.tsx'],
      actionLog: ['Listed tree .', 'Edited src/App.tsx']
    })
    expect(result.wrote).toBe(true)
    const body = getWorkspaceContext(root).body
    expect(body).toMatch(/Improve the calculator/i)
    expect(body).toMatch(/src\/App\.tsx/)
  })

  it('bootstraps Summary when pin is empty', () => {
    const root = ws()
    rememberAgentRun(root, settings('auto'), {
      goal: 'Review the project folder',
      filesTouched: ['package.json', 'src/index.ts'],
      actionLog: ['Listed tree .']
    })
    const pin = getWorkspaceContext(root).pin
    expect(pin.length).toBeGreaterThan(10)
    expect(pin).toMatch(/Focus:|Recent paths:/i)
  })

  it('proposes instead of writing in ask mode', () => {
    const root = ws()
    const result = rememberAgentRun(root, settings('ask'), {
      goal: 'Add tests',
      filesTouched: ['src/a.ts'],
      actionLog: ['Edited src/a.ts']
    })
    expect(result.wrote).toBe(false)
    expect(result.needsConfirm).toBe(true)
    expect(result.note).toBeTruthy()
    expect(getWorkspaceContext(root).body).not.toMatch(/Add tests/)
    const confirmed = confirmProjectMemory(root, {
      note: result.note,
      summary: result.summary
    })
    expect(confirmed.wrote).toBe(true)
    expect(getWorkspaceContext(root).body).toMatch(/Add tests/)
  })

  it('respects off mode', () => {
    const root = ws()
    const result = rememberAgentRun(root, settings('off'), {
      goal: 'Do work',
      filesTouched: ['a.ts'],
      actionLog: ['Edited a.ts']
    })
    expect(result.wrote).toBe(false)
  })

  it('remembers ask_user replies and supports undo', () => {
    const root = ws()
    const before = getWorkspaceContext(root).body
    const result = rememberAskUserReply(
      root,
      settings('auto'),
      'Which UI library?',
      'Use React'
    )
    expect(result.wrote).toBe(true)
    expect(getWorkspaceContext(root).body).toMatch(/Use React/)
    const undone = undoLastProjectMemory(root)
    expect(undone.ok).toBe(true)
    // Starter template or previous body — not the React note
    expect(readFileSync(join(root, '.eris', 'context.md'), 'utf8')).not.toMatch(/Use React/)
    void before
  })

  it('redacts obvious secrets from notes', () => {
    const root = ws()
    rememberAskUserReply(
      root,
      settings('auto'),
      'token?',
      'api_key=sk-secret-value-123'
    )
    expect(getWorkspaceContext(root).body).toMatch(/redacted/i)
    expect(getWorkspaceContext(root).body).not.toMatch(/sk-secret/)
  })
})
