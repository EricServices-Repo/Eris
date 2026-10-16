import { describe, expect, it } from 'vitest'
import {
  CLOUD_AGENTS_BASE_URL,
  CLOUD_AGENTS_HEALTH_PATH,
  CLOUD_AGENTS_JOBS_PATH,
  cloudAgentsFallbackReason,
  cloudAgentsStatusLabel,
  isCloudAgentsReady,
  shouldUseCloudAgents,
  type CloudHealth
} from '../src/shared/cloud-agents'
import { cloudJobToBackgroundJob } from '../electron/main/services/cloud-agents-client'
import type { CloudJob } from '../src/shared/cloud-agents'

describe('cloud agents defaults', () => {
  it('uses TLS https://agents.ericservic.es:443', () => {
    expect(CLOUD_AGENTS_BASE_URL).toBe('https://agents.ericservic.es:443')
    expect(CLOUD_AGENTS_BASE_URL.startsWith('https://')).toBe(true)
    expect(CLOUD_AGENTS_HEALTH_PATH).toBe('/v1/health')
    expect(CLOUD_AGENTS_JOBS_PATH).toBe('/v1/jobs')
  })

  it('maps cloud jobs onto the blackboard shape', () => {
    const job: CloudJob = {
      id: 'abc',
      goal: 'Add a button',
      agentId: 'coder',
      agentName: 'Coder',
      model: 'composer',
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

  it('maps artifact metadata onto background jobs', () => {
    const job: CloudJob = {
      id: 'art',
      goal: 'Edit App',
      agentId: 'coder',
      agentName: 'Coder',
      model: 'composer',
      status: 'done',
      claim: 'Edit App',
      liveStatus: 'Done · 1 file ready to apply',
      answer: 'Updated App.tsx',
      filesTouched: ['src/App.tsx'],
      hasArtifacts: true,
      artifactCount: 1,
      recentTools: [],
      thinkingTail: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z'
    }
    const mapped = cloudJobToBackgroundJob(job, '/tmp/ws')
    expect(mapped.hasArtifacts).toBe(true)
    expect(mapped.artifactCount).toBe(1)
  })
})

describe('cloud readiness + status', () => {
  const base: CloudHealth = {
    ok: true,
    authenticated: true,
    service: 'eris-cloud-agent',
    version: '0.1.0',
    llmConfigured: true,
    inference: 'local',
    maxParallel: 2,
    running: 0,
    queued: 0,
    localModel: {
      status: 'ready',
      modelId: 'composer',
      modelName: 'Composer Full',
      error: null
    }
  }

  it('is ready only when the remote health is ok and model is ready', () => {
    expect(isCloudAgentsReady(base)).toBe(true)
    expect(isCloudAgentsReady({ ...base, ok: false })).toBe(false)
    expect(
      isCloudAgentsReady({
        ...base,
        localModel: { ...base.localModel!, status: 'downloading' }
      })
    ).toBe(false)
    expect(isCloudAgentsReady(null)).toBe(false)
  })

  it('prefers cloud while the model is warming; local only on hard failures', () => {
    expect(shouldUseCloudAgents(base)).toBe(true)
    expect(
      shouldUseCloudAgents({
        ...base,
        localModel: { ...base.localModel!, status: 'downloading' }
      })
    ).toBe(true)
    expect(
      shouldUseCloudAgents({
        ...base,
        localModel: { ...base.localModel!, status: 'missing' }
      })
    ).toBe(true)
    expect(cloudAgentsFallbackReason({ ...base, ok: false })).toBe('unreachable')
    expect(
      cloudAgentsFallbackReason({
        ...base,
        localModel: { ...base.localModel!, status: 'error', error: 'boom' }
      })
    ).toBe('model-error')
    expect(shouldUseCloudAgents({ ...base, ok: false })).toBe(false)
    expect(shouldUseCloudAgents(null)).toBe(false)
  })

  it('requires EricServic.es login before preferring cloud', () => {
    expect(cloudAgentsFallbackReason({ ...base, authenticated: false })).toBe('not-authenticated')
    expect(shouldUseCloudAgents({ ...base, authenticated: false })).toBe(false)
    expect(shouldUseCloudAgents({ ...base, authenticated: undefined })).toBe(false)
    expect(isCloudAgentsReady({ ...base, authenticated: false })).toBe(false)
    expect(cloudAgentsStatusLabel({ ...base, authenticated: false })).toContain('sign in')
  })

  it('labels offline and ready states for the status bar', () => {
    expect(cloudAgentsStatusLabel(null)).toContain('checking')
    expect(cloudAgentsStatusLabel({ ...base, ok: false, error: 'Unreachable' })).toContain(
      'using local'
    )
    expect(
      cloudAgentsStatusLabel({
        ...base,
        localModel: { ...base.localModel!, status: 'downloading' }
      })
    ).toContain('downloading')
    expect(
      cloudAgentsStatusLabel({
        ...base,
        localModel: { ...base.localModel!, status: 'downloading' }
      })
    ).not.toContain('using local')
    expect(cloudAgentsStatusLabel(base)).toContain('Composer Full')
  })
})
