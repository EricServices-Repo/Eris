import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  admitChatJob,
  finishChatJob,
  flushChatJobs,
  getChatJob,
  markChatJobRunning,
  recordChatJobEvent
} from '../electron/main/services/chat-job-controller'

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
})
