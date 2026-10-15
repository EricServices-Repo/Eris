import { describe, expect, it, vi } from 'vitest'
import {
  cancelAllPendingQuestions,
  requestUserQuestion,
  resolveUserQuestion,
  USER_QUESTION_TIMEOUT_MS
} from '../electron/main/services/user-question'
import {
  looksLikeAsksForWorkspaceInfo,
  looksLikeClarifyingQuestion,
  looksLikeTaskComplete,
  shouldKeepWorking
} from '../electron/main/services/agent/heuristics'

function fakeSender() {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: Record<string, unknown>) => {
        sent.push({ channel, payload })
      }
    }
  }
}

describe('requestUserQuestion', () => {
  it('resolves with a reply', async () => {
    const { sender, sent } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Use TypeScript?')
    const req = sent.find((s) => s.channel === 'chat:question-request')
    expect(req?.payload.question).toBe('Use TypeScript?')
    expect(req?.payload.timeoutMs).toBe(USER_QUESTION_TIMEOUT_MS)
    const id = String(req?.payload.questionId)
    expect(resolveUserQuestion(id, 'yes')).toBe(true)
    await expect(p).resolves.toEqual({ kind: 'reply', text: 'yes' })
  })

  it('times out and proceeds without a reply', async () => {
    vi.useFakeTimers()
    const { sender } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Pick A or B?', {
      timeoutMs: 15_000
    })
    vi.advanceTimersByTime(15_000)
    await expect(p).resolves.toEqual({ kind: 'timeout' })
    vi.useRealTimers()
  })

  it('skip (null reply) proceeds like timeout', async () => {
    const { sender, sent } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Continue?')
    const id = String(sent[0]?.payload.questionId)
    resolveUserQuestion(id, null)
    await expect(p).resolves.toEqual({ kind: 'timeout' })
  })

  it('cancel dismisses pending questions', async () => {
    const { sender } = fakeSender()
    const p = requestUserQuestion(sender as never, 'req-1', 'Still there?')
    cancelAllPendingQuestions('req-1')
    await expect(p).resolves.toEqual({ kind: 'dismissed' })
  })
})

describe('looksLikeClarifyingQuestion', () => {
  it('detects a blocking choice question', () => {
    expect(
      looksLikeClarifyingQuestion(
        'Should I use React or Vue for this UI before I continue?'
      )
    ).toBe(true)
  })

  it('ignores finished summaries', () => {
    expect(
      looksLikeClarifyingQuestion('Done. Summary: added the login form and tests.')
    ).toBe(false)
  })

  it('does not treat workspace-info asks as clarifying questions', () => {
    const bad =
      'Sure, I\'ll review the project folder. Could you please provide the structure of the project folder and any relevant files so I can understand the current state of the calculator app?'
    expect(looksLikeAsksForWorkspaceInfo(bad)).toBe(true)
    expect(looksLikeClarifyingQuestion(bad)).toBe(false)
    expect(looksLikeTaskComplete(bad)).toBe(false)
    expect(
      shouldKeepWorking({
        needsTools: true,
        mutated: false,
        assistantText: bad,
        reviewOnly: true,
        inspectRounds: 0
      })
    ).toBe(true)
  })
})
