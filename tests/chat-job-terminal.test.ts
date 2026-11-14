import { randomUUID } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  admitChatJob,
  finishChatJob,
  flushChatJobs,
  getChatJob,
  isChatJobTerminal,
  markChatJobRunning,
  recordChatJobEvent
} from '../electron/main/services/chat-job-controller'
import { chatPublisher } from '../electron/main/services/chat-events'

/** What the renderer would receive. */
function renderer() {
  const sent: Array<[string, Record<string, unknown>]> = []
  const target = {
    isDestroyed: () => false,
    send: (channel: string, data: Record<string, unknown>) => void sent.push([channel, data])
  }
  return { sent, target: () => target as never }
}

/** #303 EX-02: a terminal task is final; late events are evidence, never a new state. */
async function admitted() {
  const id = randomUUID()
  await admitChatJob({
    id,
    workspacePath: '/fixture',
    threadId: 'thread',
    goal: 'fixture',
    submissionDigest: 'digest'
  })
  markChatJobRunning(id)
  return id
}

describe('terminal chat jobs stay terminal (#303)', () => {
  it('keeps heartbeats transient while updating activity and rejects them after terminal state (#511)', async () => {
    const id = await admitted()
    const before = getChatJob(id)!
    const now = new Date(Date.parse(before.updatedAt) + 2_000)
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      expect(recordChatJobEvent(id, 'chat:progress', { step: 1, chars: 12, elapsedMs: 2000 })).toBe(true)
      const after = getChatJob(id)!
      expect(Date.parse(after.updatedAt)).toBe(now.getTime())
      expect(after.events).toEqual(before.events)
      finishChatJob(id, 'done')
      expect(recordChatJobEvent(id, 'chat:progress', { step: 1, chars: 20, elapsedMs: 4000 })).toBe(false)
    } finally { vi.useRealTimers() }
    await flushChatJobs()
  })
  it('a later failure does not rewrite a completed task', async () => {
    const id = await admitted()
    recordChatJobEvent(id, 'chat:answer', { chunk: 'All checks passed.' })
    finishChatJob(id, 'done')
    finishChatJob(id, 'failed')
    const job = getChatJob(id)!
    expect(job).toMatchObject({ status: 'done', statusText: 'Done', lateEvents: 1 })
    expect(job.timeline?.current.phase).toBe('done')
    expect(job.events.at(-1)).toMatchObject({
      channel: 'chat:late-event',
      payload: { channel: 'terminal', status: 'failed' }
    })
    await flushChatJobs()
  })

  it('completion after a stop is recorded as late, not as done', async () => {
    const id = await admitted()
    finishChatJob(id, 'stopped')
    finishChatJob(id, 'done')
    expect(getChatJob(id)).toMatchObject({ status: 'stopped', statusText: 'Stopped' })
    await flushChatJobs()
  })

  it('late chunks, status and model events do not change the recorded result', async () => {
    const id = await admitted()
    recordChatJobEvent(id, 'chat:answer', { chunk: 'partial' })
    recordChatJobEvent(id, 'chat:model', { model: 'first' })
    finishChatJob(id, 'stopped')
    recordChatJobEvent(id, 'chat:answer', { chunk: ' and more' })
    recordChatJobEvent(id, 'chat:answer', { chunk: 'replaced', replace: true })
    recordChatJobEvent(id, 'chat:status', { text: 'Editing files…' })
    recordChatJobEvent(id, 'chat:model', { model: 'second' })
    recordChatJobEvent(id, 'chat:phase', { phase: 'tool', source: 'tool-event' })
    const job = getChatJob(id)!
    expect(job).toMatchObject({
      status: 'stopped',
      statusText: 'Stopped',
      answer: 'partial',
      model: 'first',
      lateEvents: 4
    })
    expect(job.timeline?.current.phase).toBe('stopped')
    await flushChatJobs()
  })

  it('a terminal task cannot be marked running again', async () => {
    const id = await admitted()
    finishChatJob(id, 'stopped')
    markChatJobRunning(id)
    expect(getChatJob(id)).toMatchObject({ status: 'stopped', lateEvents: 1 })
    await flushChatJobs()
  })

  it('bounds the late-event records while counting every late event', async () => {
    const id = await admitted()
    finishChatJob(id, 'done')
    for (let i = 0; i < 20; i++) recordChatJobEvent(id, 'chat:answer', { chunk: 'x' })
    const job = getChatJob(id)!
    expect(job.lateEvents).toBe(20)
    expect(job.events.filter((event) => event.channel === 'chat:late-event')).toHaveLength(8)
    await flushChatJobs()
  })

  it('a running task still records events and finishes normally', async () => {
    const id = await admitted()
    recordChatJobEvent(id, 'chat:answer', { chunk: 'a' })
    recordChatJobEvent(id, 'chat:answer', { chunk: 'b' })
    recordChatJobEvent(id, 'chat:status', { text: 'Verifying' })
    expect(getChatJob(id)).toMatchObject({
      status: 'running',
      answer: 'ab',
      statusText: 'Verifying'
    })
    finishChatJob(id, 'incomplete')
    expect(getChatJob(id)).toMatchObject({ status: 'incomplete' })
    expect(getChatJob(id)!.lateEvents).toBeUndefined()
    await flushChatJobs()
  })

  it('does not send the renderer an error, chunk or second outcome after the task ended', async () => {
    const id = await admitted()
    const { sent, target } = renderer()
    const publish = chatPublisher(id, target)
    publish('chat:answer', { requestId: id, chunk: 'Done.' })
    publish('chat:done', { requestId: id })
    expect(isChatJobTerminal(id)).toBe(true)
    // The outer chat:stream catch after chat:done, then stragglers.
    publish('chat:error', { requestId: id, error: 'late failure' })
    publish('chat:answer', { requestId: id, chunk: ' more' })
    publish('chat:done', { requestId: id, aborted: true })
    expect(sent.map(([channel]) => channel)).toEqual(['chat:answer', 'chat:done'])
    expect(getChatJob(id)).toMatchObject({ status: 'done', answer: 'Done.', lateEvents: 3 })
    await flushChatJobs()
  })

  it('still forwards every event while the task runs, and for unknown tasks', async () => {
    const id = await admitted()
    const { sent, target } = renderer()
    chatPublisher(id, target)('chat:error', { requestId: id, error: 'real failure' })
    expect(sent.map(([channel]) => channel)).toEqual(['chat:error'])
    expect(getChatJob(id)).toMatchObject({ status: 'failed' })
    const unknown = renderer()
    chatPublisher('not-admitted', unknown.target)('chat:status', { text: 'x' })
    expect(unknown.sent).toHaveLength(1)
    expect(isChatJobTerminal('not-admitted')).toBe(false)
    await flushChatJobs()
  })
})


describe('observed chat progress (#470)', () => {
  it('reports only successful reads, actual diff events, verification and repeated failures', async () => {
    const { observedChatProgress } = await import('../src/shared/chat-progress')
    const id = await admitted()
    recordChatJobEvent(id, 'chat:tool', { tool: { name: 'read_file', status: 'ok', path: 'src/a.ts' } })
    expect(observedChatProgress(getChatJob(id)!.events)).toMatchObject({ lastSuccess: { name: 'read_file', path: 'src/a.ts' }, changedFiles: [] })
    recordChatJobEvent(id, 'chat:tool', { tool: { name: 'write_file', status: 'error', path: 'src/b.ts', failure: { code: 'DENIED' } } })
    recordChatJobEvent(id, 'chat:tool', { tool: { name: 'write_file', status: 'error', path: 'src/b.ts', failure: { code: 'DENIED' } } })
    let progress = observedChatProgress(getChatJob(id)!.events)
    expect(progress.changedFiles).toEqual([])
    expect(progress.lastFailure).toEqual({ name: 'write_file', code: 'DENIED', repeats: 2 })
    recordChatJobEvent(id, 'chat:diff', { diff: { path: 'src/b.ts', op: 'write' } })
    recordChatJobEvent(id, 'chat:tool', { tool: { name: 'verify', status: 'ok', path: 'npm test' } })
    progress = observedChatProgress(getChatJob(id)!.events)
    expect(progress.changedFiles).toEqual(['src/b.ts'])
    expect(progress.verification).toEqual({ command: 'npm test', result: 'passed' })
    recordChatJobEvent(id, 'chat:diff', { diff: { path: 'src/a.ts', op: 'write' } })
    expect(observedChatProgress(getChatJob(id)!.events).verification).toBeUndefined()
    finishChatJob(id, 'done')
    await flushChatJobs()
  })
})
