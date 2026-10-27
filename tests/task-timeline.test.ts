import { describe, it, expect, vi } from 'vitest'
import { ForegroundTasks } from '../electron/main/services/foreground-tasks'
import { transitionTaskTimeline } from '../src/shared/task-timeline'
import { runWithChatActivity, reportChatActivity } from '../electron/main/services/chat-activity'
import {
  requestCommandApproval,
  pendingCommandApprovals,
  resolveCommandApproval
} from '../electron/main/services/command-approval'
import {
  requestUserQuestion,
  pendingUserQuestions,
  resolveUserQuestion
} from '../electron/main/services/user-question'
import type { WebContents } from 'electron'
const tick = () => new Promise((resolve) => setImmediate(resolve))
describe('owned task phases and FIFO cancellation', () => {
  it('cancels a queued middle task immediately without releasing work ahead of it', async () => {
    const states: unknown[] = [],
      queue = new ForegroundTasks((state) => states.push(state)),
      owner = {},
      foreign = {}
    let release!: () => void
    const order: string[] = []
    const first = queue.run('first', owner, async () => {
      order.push('first')
      await new Promise<void>((r) => (release = r))
    })
    await tick()
    const middle = queue.run('middle', owner, async () => {
      order.push('middle')
    })
    const rejected = expect(middle).rejects.toMatchObject({ name: 'AbortError' })
    const last = queue.run('last', owner, async () => {
      order.push('last')
    })
    expect(queue.stop('middle', foreign)).toBe(false)
    expect(queue.stop('middle', owner)).toBe(true)
    await rejected
    expect(order).toEqual(['first'])
    expect(states).toContainEqual(
      expect.objectContaining({ id: 'last', phase: 'queued', position: 1, blockedBy: 'first' })
    )
    release()
    await first
    await last
    expect(order).toEqual(['first', 'last'])
    expect(queue.size).toBe(0)
  })
  it('separates foreground queue and model preparation from dispatch-to-first-chunk timing', () => {
    let t = transitionTaskTimeline('a', undefined, { phase: 'queued', at: 100 }, 100)
    t = transitionTaskTimeline('a', t, { phase: 'admitted', at: 200 }, 200)
    t = transitionTaskTimeline('a', t, { phase: 'loading', at: 300, source: 'transport' }, 300)
    t = transitionTaskTimeline('a', t, { phase: 'prefill', at: 800, source: 'transport' }, 800)
    t = transitionTaskTimeline('a', t, { phase: 'generating', at: 900, source: 'transport' }, 900)
    expect(t.queueWaitMs).toBe(100)
    expect(t.loadingMs).toBe(500)
    expect(t.dispatchToFirstChunkMs).toBe(100)
    t = transitionTaskTimeline('a', t, { phase: 'done', at: 1000 }, 1000)
    expect(transitionTaskTimeline('a', t, { phase: 'generating', source: 'transport' }, 1200)).toBe(
      t
    )
  })
  it('retains bounded evidence and an explicit wait rather than background model chatter', () => {
    let t = transitionTaskTimeline(
      'a',
      undefined,
      { phase: 'waiting-child', at: 10, source: 'coordinator' },
      10
    )
    expect(transitionTaskTimeline('a', t, { phase: 'generating', source: 'transport' }, 20)).toBe(t)
    for (let i = 0; i < 200; i++)
      t = transitionTaskTimeline(
        'a',
        t,
        { phase: i % 2 ? 'tool' : 'integrating', at: 30 + i },
        30 + i
      )
    expect(t.entries).toHaveLength(96)
    expect(t.entries.every((e) => e.taskId === 'a')).toBe(true)
    expect(t.dispatchToFirstChunkMs).toBeNull()
  })
  it('keeps concurrent async task activity scopes separate', async () => {
    const a: unknown[] = [],
      b: unknown[] = []
    await Promise.all([
      runWithChatActivity(
        'a',
        (e) => a.push(e),
        async () => {
          await tick()
          reportChatActivity('loading')
        }
      ),
      runWithChatActivity(
        'b',
        (e) => b.push(e),
        async () => {
          reportChatActivity('routing')
          await tick()
          reportChatActivity('generating')
        }
      )
    ])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
    expect(a[0]).toMatchObject({ phase: 'loading' })
  })
  it('restores only existing owner-bound interaction tickets and resolves them once', async () => {
    const sender = { send: vi.fn(), isDestroyed: () => false } as unknown as WebContents,
      foreign = { send: vi.fn(), isDestroyed: () => false } as unknown as WebContents
    const approval = requestCommandApproval(sender, 'task', 'run', 'npm test')
    const tickets = pendingCommandApprovals('task', sender)
    expect(tickets).toHaveLength(1)
    expect(pendingCommandApprovals('task', foreign)).toHaveLength(0)
    expect(pendingCommandApprovals('task', sender)[0].approvalId).toBe(tickets[0].approvalId)
    expect(resolveCommandApproval(tickets[0].approvalId, 'allow')).toBe(true)
    expect(await approval).toBe('allow')
    expect(resolveCommandApproval(tickets[0].approvalId, 'allow')).toBe(false)
    const question = requestUserQuestion(sender, 'task', 'Choose a target', { timeoutMs: 10000 }),
      q = pendingUserQuestions('task', sender)[0]
    expect(pendingUserQuestions('task', foreign)).toHaveLength(0)
    resolveUserQuestion(q.questionId, 'target')
    expect(await question).toEqual({ kind: 'reply', text: 'target' })
    expect(pendingUserQuestions('task', sender)).toHaveLength(0)
  })
})
