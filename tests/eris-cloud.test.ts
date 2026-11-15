import { describe, expect, it } from 'vitest'
import {
  ERIS_CLOUD_BASE_URL,
  ERIS_CLOUD_TOKEN_REF,
  isErisCloudConnection,
  isLocalOllamaConnection,
  normalizeErisCloudConnection,
  parseHostedModels
} from '../src/shared/eris-cloud'
import { CLOUD_AGENTS_ENABLED } from '../src/shared/cloud-agents'
import { cloudAgentsHealth } from '../electron/main/services/cloud-agents-client'

describe('Eris Cloud connection', () => {
  it('keeps the hosted server apart from the user’s own Ollama', () => {
    expect(isLocalOllamaConnection({ id: 'ollama', type: 'openai-compatible', provider: 'ollama' })).toBe(true)
    expect(isLocalOllamaConnection({ id: 'lan', type: 'openai-compatible', provider: 'ollama' })).toBe(true)
    expect(isLocalOllamaConnection({ id: 'eris-cloud', type: 'openai-compatible', provider: 'ollama' })).toBe(false)
    expect(isLocalOllamaConnection({ id: 'oa', type: 'openai-compatible', provider: 'openai' })).toBe(false)
    expect(isErisCloudConnection({ id: 'eris-cloud' })).toBe(true)
  })

  it('pins URL and token auth but keeps enabled/models', () => {
    const c = normalizeErisCloudConnection({
      id: 'eris-cloud',
      enabled: true,
      models: ['qwen3:8b'],
      baseUrl: 'http://evil.invalid',
      apiKeyRef: 'eris-cloud'
    })
    expect(c).toMatchObject({
      enabled: true,
      models: ['qwen3:8b'],
      baseUrl: ERIS_CLOUD_BASE_URL,
      apiKeyRef: ERIS_CLOUD_TOKEN_REF,
      provider: 'ollama',
      type: 'openai-compatible'
    })
  })

  it('parses the /me hostedModels block', () => {
    expect(parseHostedModels(undefined)).toBeNull()
    expect(parseHostedModels({ enabled: false })).toEqual({ enabled: false, baseUrl: undefined })
    expect(parseHostedModels({ enabled: true, baseUrl: ERIS_CLOUD_BASE_URL })).toEqual({
      enabled: true,
      baseUrl: ERIS_CLOUD_BASE_URL
    })
  })
})

describe('retired Cloud Agents', () => {
  it('reports offline without any network request', async () => {
    expect(CLOUD_AGENTS_ENABLED).toBe(false)
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error('no network expected')
    }) as typeof fetch
    try {
      const health = await cloudAgentsHealth(true)
      expect(health.ok).toBe(false)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
