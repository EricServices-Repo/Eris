import { describe, expect, it } from 'vitest'
import { getModelsStatus } from '../electron/main/services/model-catalog'
import { getDefaults } from '../electron/main/services/settings'
import type { AppSettings } from '../src/shared/settings-schema'

function settingsWithConnection(): AppSettings {
  const base = getDefaults()
  return {
    ...base,
    models: {
      ...base.models,
      connections: [
        {
          id: 'conn-openai',
          name: 'OpenAI',
          type: 'openai-compatible',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          enabled: true,
          models: ['gpt-4o-mini'],
          apiKeyRef: 'openai'
        }
      ]
    }
  }
}

describe('getModelsStatus light path', () => {
  it('skips live /v1/models probes and treats persisted models as ready', async () => {
    const status = await getModelsStatus(settingsWithConnection(), () => null, {})
    const conn = status.connections.find((c) => c.id === 'conn-openai')
    expect(conn?.reachable).toBe(true)
    expect(status.models.some((m) => m.name === 'gpt-4o-mini' && m.ready)).toBe(true)
    expect(status.gpu).toBeUndefined()
  })

  it('includes gpu only when requested', async () => {
    const status = await getModelsStatus(settingsWithConnection(), () => null, {
      includeGpu: true
    })
    expect(status.gpu).toBeDefined()
    expect(typeof status.gpu?.accelUsable).toBe('boolean')
  })
})
