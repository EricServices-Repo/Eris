import { describe, expect, it } from 'vitest'
import { formatBackgroundJobDetail } from '../src/shared/background-job-detail'
import type { BackgroundJob } from '../src/shared/background-agents'

function job(partial: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: 'j1',
    workspacePath: '/tmp/ws',
    worktreePath: '/tmp/wt',
    branch: 'eris/agent-j1',
    goal: 'Add a button',
    model: 'builtin:composer-1.5',
    agentId: 'coder',
    agentName: 'Coder',
    intent: 'edit',
    routeReason: 'Edit intent → tools',
    chatModel: 'builtin:composer-lite',
    toolsModel: 'builtin:composer-1.5',
    source: 'chat',
    status: 'running',
    step: 2,
    actionLog: [],
    filesTouched: [],
    answer: '',
    liveStatus: 'write_file: ok',
    recentTools: [
      {
        id: 't1',
        name: 'write_file',
        path: 'src/App.tsx',
        status: 'ok',
        detail: 'wrote',
        at: '2026-01-01T00:00:00.000Z'
      }
    ],
    thinkingTail: 'Planning the change…',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...partial
  }
}

describe('formatBackgroundJobDetail', () => {
  it('shows route, live tools, and pending-diff hint while running', () => {
    const text = formatBackgroundJobDetail(job({}), '')
    expect(text).toContain('RUNNING · running · eris/agent-j1')
    expect(text).toContain('Edit intent → tools')
    expect(text).toContain('status: write_file: ok')
    expect(text).toContain('model: composer-1.5')
    expect(text).toContain('(chat composer-lite)')
    expect(text).toContain('✓ write_file src/App.tsx')
    expect(text).toContain('Thinking (tail)')
    expect(text).toContain('(diff available when the job finishes)')
  })

  it('includes answer and diff when finished', () => {
    const text = formatBackgroundJobDetail(
      job({ status: 'done', answer: 'Updated App.tsx', liveStatus: 'Done' }),
      'diff --git a/src/App.tsx'
    )
    expect(text).toContain('READY-TO-MERGE')
    expect(text).toContain('Answer')
    expect(text).toContain('Updated App.tsx')
    expect(text).toContain('Diff')
    expect(text).toContain('diff --git a/src/App.tsx')
  })
})
