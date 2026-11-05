import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../electron/main/services/settings', () => ({
  getResolvedSettings: () => ({
    ericServices: { linked: true, tokenRef: 'eris-token', apiBase: 'https://usage.example' }
  })
}))
vi.mock('../electron/main/ipc/shared', () => ({ getSecret: () => 'eseris_test_token' }))

import {
  flushUsageDelta,
  pendingUsageDeltas,
  queueUsageDelta
} from '../electron/main/services/usage-sync'

const posts: Array<{ day: string; delta: Record<string, number> }> = []

function respond(statuses: number[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body))
      const status = statuses.shift() ?? 200
      if (status === 0) throw new Error('socket hang up')
      return new Response(JSON.stringify({ ok: status < 400 }), { status })
    })
  )
}

afterEach(async () => {
  vi.unstubAllGlobals()
  respond([])
  await flushUsageDelta()
  posts.length = 0
})

describe('usage push day attribution', () => {
  it('posts each delta under the day it was recorded', async () => {
    respond([200, 200])
    queueUsageDelta({ requests: 1, inputTokens: 10 }, new Date(2026, 10, 3, 23, 59))
    queueUsageDelta({ requests: 2, outputTokens: 5 }, new Date(2026, 10, 4, 0, 1))
    await flushUsageDelta()
    expect(posts.map((p) => [p.day, p.delta.requests])).toEqual([
      ['2026-11-03', 1],
      ['2026-11-04', 2]
    ])
    expect(pendingUsageDeltas()).toEqual([])
  })

  it('keeps a failed push on its original day when it is retried later', async () => {
    respond([0])
    queueUsageDelta({ requests: 3, inputTokens: 30 }, new Date(2026, 10, 3, 23, 50))
    await flushUsageDelta()
    expect(pendingUsageDeltas()).toEqual([
      { day: '2026-11-03', requests: 3, inputTokens: 30, outputTokens: 0, cloudJobs: 0 }
    ])

    respond([200, 200])
    queueUsageDelta({ requests: 1 }, new Date(2026, 10, 4, 0, 10))
    posts.length = 0
    await flushUsageDelta()
    expect(posts.map((p) => [p.day, p.delta.requests])).toEqual([
      ['2026-11-03', 3],
      ['2026-11-04', 1]
    ])
  })

  it('does not re-queue a day the site refused at its cap', async () => {
    respond([409])
    queueUsageDelta({ requests: 1 }, new Date(2026, 10, 4, 9))
    await flushUsageDelta()
    expect(pendingUsageDeltas()).toEqual([])
  })
})
