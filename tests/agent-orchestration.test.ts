import { describe, expect, it } from 'vitest'
import {
  deriveBlackboardStatus,
  formatHandoffForPrompt,
  formatJobResultForChat
} from '../src/shared/agent-orchestration'
import { formatBackgroundJobDetail } from '../src/shared/background-job-detail'
import type { BackgroundJob } from '../src/shared/background-agents'
import { shouldConsiderMidRunAdapt } from '../electron/main/services/agent/mid-run-adapt'

describe('agent orchestration', () => {
  it('formats handoff packets for specialists', () => {
    const text = formatHandoffForPrompt({
      goal: 'Add login button',
      summary: 'Auth form needs a submit control',
      files: ['src/Login.tsx'],
      openQuestions: ['Dark mode?'],
      confidence: 0.8,
      fromAgentId: 'composer',
      toAgentId: 'coder'
    })
    expect(text).toContain('composer')
    expect(text).toContain('coder')
    expect(text).toContain('src/Login.tsx')
    expect(text).toContain('Dark mode?')
  })

  it('derives blackboard statuses', () => {
    expect(deriveBlackboardStatus({ status: 'queued' })).toBe('queued')
    expect(deriveBlackboardStatus({ status: 'done' })).toBe('ready-to-merge')
    expect(
      deriveBlackboardStatus({ status: 'running', liveStatus: 'Waiting for approval: npm test' })
    ).toBe('needs-approval')
    expect(
      deriveBlackboardStatus({ status: 'running', liveStatus: 'Waiting for children…' })
    ).toBe('blocked')
  })

  it('formats chat paste from a finished job', () => {
    const text = formatJobResultForChat({
      goal: 'Fix types',
      agentName: 'Coder',
      status: 'ready-to-merge',
      answer: 'Updated App.tsx',
      filesTouched: ['src/App.tsx'],
      routeReason: 'Edit → coder'
    })
    expect(text).toContain('Coder')
    expect(text).toContain('src/App.tsx')
    expect(text).toContain('Updated App.tsx')
  })

  it('shows parent/child and route history in job detail', () => {
    const job: BackgroundJob = {
      id: 'parent-1',
      workspacePath: '/tmp/ws',
      worktreePath: '/tmp/wt',
      branch: 'eris/agent-parent',
      goal: 'Ship feature',
      model: 'builtin:composer',
      agentId: 'composer',
      agentName: 'Composer',
      status: 'running',
      step: 1,
      actionLog: [],
      filesTouched: [],
      answer: '',
      claim: 'Orchestrate auth',
      parentId: null,
      childIds: ['child-aaaa-bbbb'],
      liveStatus: 'Waiting for children…',
      blackboard: 'blocked',
      routeHistory: [
        {
          at: '2026-01-01T00:00:00.000Z',
          agentId: 'composer',
          agentName: 'Composer',
          model: 'builtin:composer',
          reason: 'Plan',
          kind: 'plan'
        },
        {
          at: '2026-01-01T00:01:00.000Z',
          agentId: 'coder',
          model: 'builtin:composer',
          reason: 'Delegated: implement login',
          kind: 'delegate'
        }
      ],
      escalateCount: 1,
      rerouteCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z'
    }
    const text = formatBackgroundJobDetail(job, '')
    expect(text).toContain('BLOCKED')
    expect(text).toContain('claim: Orchestrate auth')
    expect(text).toContain('children: child-aa')
    expect(text).toContain('[delegate]')
    expect(text).toContain('escalate×1')
  })
})

describe('mid-run adapt gates', () => {
  it('triggers on stuck signals within budget', () => {
    expect(
      shouldConsiderMidRunAdapt({
        verifyFailures: 2,
        consecutiveToolErrors: 0,
        noProgressStreak: 0,
        escalateCount: 0,
        rerouteCount: 0
      })
    ).toBe(true)
    expect(
      shouldConsiderMidRunAdapt({
        verifyFailures: 0,
        consecutiveToolErrors: 0,
        noProgressStreak: 0,
        escalateCount: 1,
        rerouteCount: 1
      })
    ).toBe(false)
  })
})
