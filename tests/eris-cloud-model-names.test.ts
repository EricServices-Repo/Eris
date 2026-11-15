import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  connectionModelRef,
  erisCloudModelRef,
  ERIS_CLOUD_TOKEN_REF,
  isErisCloudModelRef,
  providerModelId
} from '../src/shared/eris-cloud'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'
import { getModelsStatus, resolveConnectionForModel } from '../electron/main/services/model-catalog'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import {
  getDefaults,
  getResolvedSettings,
  invalidateResolvedSettingsCache
} from '../electron/main/services/settings'
import { userSettingsPath } from '../electron/main/services/paths'

/** Eris Cloud models are named `cloud:<model>` in Eris and sent bare to the server. */

afterEach(() => vi.unstubAllGlobals())

function settingsWith(cloudModels: string[], ollamaModels: string[] = []): AppSettings {
  const settings = structuredClone(getDefaults())
  settings.models.connections = settings.models.connections.map((c) =>
    c.id === 'eris-cloud' ? { ...c, enabled: true, models: cloudModels } : c
  )
  if (ollamaModels.length) {
    const ollama: ModelConnection = {
      id: 'ollama',
      name: 'Ollama',
      type: 'openai-compatible',
      provider: 'ollama',
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyRef: '',
      models: ollamaModels
    }
    settings.models.connections.push(ollama)
  }
  return settings
}

describe('cloud: model names', () => {
  it('names and strips Eris Cloud refs', () => {
    expect(erisCloudModelRef('qwen3:8b')).toBe('cloud:qwen3:8b')
    expect(erisCloudModelRef('cloud:qwen3:8b')).toBe('cloud:qwen3:8b')
    expect(isErisCloudModelRef('cloud:qwen3:8b')).toBe(true)
    expect(isErisCloudModelRef('cloud:')).toBe(false)
    expect(isErisCloudModelRef('qwen3:8b')).toBe(false)
    expect(providerModelId('cloud:qwen3:8b')).toBe('qwen3:8b')
    expect(providerModelId('qwen3:8b')).toBe('qwen3:8b')
    expect(connectionModelRef({ id: 'eris-cloud' }, 'qwen3:8b')).toBe('cloud:qwen3:8b')
    expect(connectionModelRef({ id: 'ollama' }, 'qwen3:8b')).toBe('qwen3:8b')
  })

  it('lists Eris Cloud models as cloud:<model> and other providers unchanged', async () => {
    const status = await getModelsStatus(settingsWith(['qwen3:8b'], ['qwen3:8b']), () => null)
    const names = status.models
      .filter((m) => m.source === 'connection')
      .map((m) => `${m.connectionId}=${m.name}`)
    expect(names).toEqual(expect.arrayContaining(['eris-cloud=cloud:qwen3:8b', 'ollama=qwen3:8b']))
  })

  it('uses the live Eris Cloud catalog even when the server lists zero models', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [] }))
    const status = await getModelsStatus(settingsWith(['retired-model']), () => null, {
      probeConnections: true
    })
    expect(status.connections.find(c => c.id === 'eris-cloud')).toMatchObject({
      reachable: true,
      models: []
    })
    expect(status.models.filter(m => m.connectionId === 'eris-cloud')).toEqual([])
  })

  it('routes cloud: to Eris Cloud and a bare id to the user’s own Ollama', () => {
    const settings = settingsWith(['qwen3:8b'], ['qwen3:8b'])
    expect(resolveConnectionForModel(settings, 'cloud:qwen3:8b')?.id).toBe('eris-cloud')
    expect(resolveConnectionForModel(settings, 'qwen3:8b')?.id).toBe('ollama')
    // An older saved selection of a model only Eris Cloud has still resolves there.
    expect(resolveConnectionForModel(settingsWith(['gemma3']), 'gemma3')?.id).toBe('eris-cloud')
  })

  it('sends the bare model id to the Eris Cloud server', async () => {
    const bodies: Array<{ model?: string }> = []
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      urls.push(String(url))
      if (init?.body) bodies.push(JSON.parse(init.body))
      const frame = { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { status: 200 })
    })
    let text = ''
    for await (const chunk of streamModelChat({
      settings: settingsWith(['qwen3:8b'], ['qwen3:8b']),
      model: 'cloud:qwen3:8b',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0,
      getSecret: (key) => (key === ERIS_CLOUD_TOKEN_REF ? 'eseris_test' : null)
    }))
      text += chunk
    expect(text).toBe('hi')
    const chat = bodies.find((body) => body.model)
    expect(chat?.model).toBe('qwen3:8b')
    expect(urls.some((url) => url.startsWith('https://agents.ericservic.es/v1'))).toBe(true)
    expect(urls.some((url) => url.includes('127.0.0.1:11434'))).toBe(false)
  })

  it('migrates a default chosen from Eris Cloud before the prefix', () => {
    const write = (raw: unknown) => {
      mkdirSync(dirname(userSettingsPath()), { recursive: true })
      writeFileSync(userSettingsPath(), JSON.stringify(raw))
      invalidateResolvedSettingsCache()
    }
    const cloud = { id: 'eris-cloud', enabled: true, models: ['qwen3:8b'] }
    write({ models: { defaultModel: 'qwen3:8b', connections: [cloud] } })
    expect(getResolvedSettings(null).models.defaultModel).toBe('cloud:qwen3:8b')
    // The same id on the user's own Ollama keeps meaning that model.
    write({
      models: {
        defaultModel: 'qwen3:8b',
        connections: [
          cloud,
          { id: 'ollama', name: 'Ollama', type: 'openai-compatible', provider: 'ollama', enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKeyRef: '', models: ['qwen3:8b'] }
        ]
      }
    })
    expect(getResolvedSettings(null).models.defaultModel).toBe('qwen3:8b')
  })
})
