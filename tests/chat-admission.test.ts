import { randomUUID } from 'crypto'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { userDataRoot } from '../electron/main/services/paths'
const fault = vi.hoisted(() => ({ rename: false }))
vi.mock('fs/promises', async () => {
  const fs = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fault.rename) throw new Error('synthetic write fault')
      return fs.rename(...args)
    }
  }
})
describe('durable task admission', () => {
  it('acknowledges persisted content, reattaches duplicates and rejects ID conflicts', async () => {
    const jobs = await import('../electron/main/services/chat-job-controller')
    const input = {
      id: randomUUID(),
      workspacePath: '/fixture',
      threadId: 'fixture-thread',
      goal: 'fixture',
      submissionDigest: 'synthetic-digest'
    }
    const [first, second] = await Promise.all([jobs.admitChatJob(input), jobs.admitChatJob(input)])
    expect([first.duplicate, second.duplicate]).toEqual([false, true])
    const records = readdirSync(join(userDataRoot(), 'chat-jobs'))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(userDataRoot(), 'chat-jobs', name), 'utf8')))
    expect(records.some((record) => record.id === input.id && record.status === 'queued')).toBe(
      true
    )
    await expect(jobs.admitChatJob({ ...input, submissionDigest: 'different' })).rejects.toThrow(
      'conflict'
    )
    jobs.finishChatJob(input.id, 'done')
    await jobs.flushChatJobs()
  })
  it('reports storage failure before any execution and permits a safe retry', async () => {
    const jobs = await import('../electron/main/services/chat-job-controller')
    const input = {
      id: randomUUID(),
      workspacePath: null,
      threadId: null,
      goal: 'fixture',
      submissionDigest: 'digest'
    }
    fault.rename = true
    try {
      await expect(jobs.admitChatJob(input)).rejects.toThrow('storage is unavailable')
    } finally {
      fault.rename = false
    }
    const retry = await jobs.admitChatJob(input)
    // If the record was written before a later index failed, recovery reattaches it;
    // this synthetic fault fails the first rename, so no record was admitted.
    expect(retry.duplicate).toBe(false)
    jobs.finishChatJob(input.id, 'stopped')
    await jobs.flushChatJobs()
  })
  it('recovers a crash as stopped and locates an older thread independently of the latest task', async () => {
    const jobs = await import('../electron/main/services/chat-job-controller')
    const first = {
      id: randomUUID(),
      workspacePath: '/recover',
      threadId: 'older',
      goal: 'old',
      submissionDigest: 'one'
    }
    const second = { ...first, id: randomUUID(), threadId: 'newer', submissionDigest: 'two' }
    await jobs.admitChatJob(first)
    await jobs.admitChatJob(second)
    await jobs.flushChatJobs()
    vi.resetModules()
    const recovered = await import('../electron/main/services/chat-job-controller')
    expect(recovered.getLatestChatJob('/recover', 'older')).toMatchObject({
      id: first.id,
      status: 'stopped'
    })
    expect((await recovered.admitChatJob(first)).duplicate).toBe(true)
    await recovered.flushChatJobs()
  })
})
