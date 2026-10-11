import { describe, expect, it } from 'vitest'
import {
  CLOUD_AGENTS_BASE_URL,
  CLOUD_AGENTS_HEALTH_PATH,
  CLOUD_AGENTS_JOBS_PATH
} from '../src/shared/cloud-agents'
import { cloudJobToBackgroundJob } from '../electron/main/services/cloud-agents-client'
import type { CloudJob } from '../src/shared/cloud-agents'

describe('cloud agents defaults', () => {
  it('uses agents.ericservic.es:6443 with no user config', () => {
    expect(CLOUD_AGENTS_BASE_URL).toBe('https://agents.ericservic.es:6443')
    expect(CLOUD_AGENTS_HEALTH_PATH).toBe('/v1/health')
    expect(CLOUD_AGENTS_JOBS_PATH).toBe('/v1/jobs')
  })

  it('maps cloud jobs onto the blackboard shape', () => {
    const job: CloudJob = {
      id: 'abc',
      goal: 'Add a button',
      agentId: 'coder',
      agentName: 'Coder',
      model: 'gpt-4o-mini',
      status: 'running',
      claim: 'Add a button',
      liveStatus: 'Coder · step 2',
      answer: '',
      filesTouched: ['src/App.tsx'],
      recentTools: [],
      thinkingTail: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z'
    }
    const mapped = cloudJobToBackgroundJob(job, '/tmp/ws')
    expect(mapped.id).toBe('cloud:abc')
    expect(mapped.status).toBe('running')
    expect(mapped.routeReason).toContain('agents.ericservic.es')
    expect(mapped.filesTouched).toEqual(['src/App.tsx'])
  })
})
