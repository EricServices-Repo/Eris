import { describe, expect, it } from 'vitest'
import { resolveRoutingCapabilityProfile } from '../electron/main/services/model-capability-ranking'
import { recordProviderContexts } from '../electron/main/services/provider-context'
import { getDefaults } from '../electron/main/services/settings'
import type { ModelConnection } from '../src/shared/settings-schema'

describe('routing capability precedence', () => {
  const id = 'openai/gpt-5'
  const connection: ModelConnection = {
    id: 'openrouter', name: 'OpenRouter', enabled: true, type: 'openai-compatible',
    provider: 'openrouter', apiKeyRef: '', models: [id], baseUrl: 'https://router.example/v1'
  }
  it('combines size, family, provider facts, and the user override field by field', () => {
    const settings = structuredClone(getDefaults())
    const profile = (name = id) => resolveRoutingCapabilityProfile(settings, name, { local: false, connection })
    expect(profile('qwen-coder-1.5b')).toMatchObject({ tier: 'small', toolCalling: 'text' })
    expect(profile()).toMatchObject({ tier: 'frontier', toolCalling: 'native', reasoning: true })
    recordProviderContexts(connection.baseUrl, [{
      id,
      context_length: 131072,
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.000001', completion: '0.000002' }
    }])
    expect(profile()).toMatchObject({
      tier: 'frontier', toolCalling: 'native', contextWindow: 131072,
      reasoning: false, vision: true, costClass: 'low'
    })
    settings.models.capabilityProfiles[id] = {
      tier: 'standard', toolCalling: 'none', contextWindow: 4096,
      reasoning: true, vision: false, costClass: 'high'
    }
    expect(profile()).toMatchObject(settings.models.capabilityProfiles[id])
    settings.models.capabilityProfiles[id].enabled = false
    expect(profile()).toMatchObject({ tier: 'frontier', contextWindow: 131072 })
    expect(resolveRoutingCapabilityProfile(settings, id, {
      local: false, connection: { ...connection, baseUrl: 'https://another.example/v1' }
    }).contextWindow).toBe(settings.models.contextWindow)
  })
})
