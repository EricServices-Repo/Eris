import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  connectionModelRef,
  erisCloudModelRef,
  ERIS_CLOUD_TOKEN_REF,
  isErisCloudModelRef,
  providerModelId
} from '../src/shared/eris-cloud'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'
import { connectionsWithDiscoveredModels, getModelsStatus, resolveConnectionForModel } from '../electron/main/services/model-catalog'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import {
  getDefaults,
  getResolvedSettings,
  invalidateResolvedSettingsCache,
  setSettings
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
    const settings = settingsWith(['retired-model'])
    const status = await getModelsStatus(settings, () => 'fixture-token', {
      probeConnections: true
    })
    expect(status.connections.find(c => c.id === 'eris-cloud')).toMatchObject({
      reachable: true,
      models: []
    })
    expect(status.models.filter(m => m.connectionId === 'eris-cloud')).toEqual([])
    const update = connectionsWithDiscoveredModels(settings, status)
    expect(update.changed).toBe(true)
    settings.models.connections = update.connections
    const offline = await getModelsStatus(settings, () => null)
    expect(offline.models.find(model => model.name === 'cloud:retired-model')).toBeUndefined()
    expect(resolveConnectionForModel(settings, 'cloud:retired-model')).toBeNull()
    expect(resolveConnectionForModel(settings, 'retired-model')).toBeNull()
  })

  it('refreshes only Cloud and preserves a same-named local Ollama model', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'still-on' }] }))
    vi.stubGlobal('fetch', fetch)
    const settings = settingsWith(['retired-model', 'still-on'], ['retired-model'])
    const status = await getModelsStatus(settings, () => 'fixture-token', { probeCloud: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(status.models.map(model => model.name)).toEqual(expect.arrayContaining(['cloud:still-on', 'retired-model']))
    expect(status.models.some(model => model.name === 'cloud:retired-model')).toBe(false)
    settings.models.connections = connectionsWithDiscoveredModels(settings, status, { cloudOnly: true }).connections
    expect(resolveConnectionForModel(settings, 'cloud:retired-model')).toBeNull()
    expect(resolveConnectionForModel(settings, 'retired-model')?.id).toBe('ollama')
  })

  it('does not restore old Cloud entries when the signed-in catalog request fails', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }))
    const settings = settingsWith(['retired-model'])
    const status = await getModelsStatus(settings, () => 'fixture-token', { probeCloud: true })
    expect(status.connections.find(c => c.id === 'eris-cloud')).toMatchObject({ reachable: false, models: [] })
    expect(connectionsWithDiscoveredModels(settings, status, { cloudOnly: true }).connections.find(c => c.id === 'eris-cloud')?.models).toEqual([])
  })

  it('routes cloud: to Eris Cloud and a bare id to the user’s own Ollama', () => {
    const settings = settingsWith(['qwen3:8b'], ['qwen3:8b'])
    expect(resolveConnectionForModel(settings, 'cloud:qwen3:8b')?.id).toBe('eris-cloud')
    expect(resolveConnectionForModel(settings, 'qwen3:8b')?.id).toBe('ollama')
    // An older saved selection of a model only Eris Cloud has still resolves there.
    expect(resolveConnectionForModel(settingsWith(['gemma3']), 'gemma3')?.id).toBe('eris-cloud')
  })

  it('rejects a removed Cloud selection without sending its chat to another connection', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const reply = streamModelChat({
      settings: settingsWith([], ['retired-model']),
      model: 'cloud:retired-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0,
      getSecret: () => 'fixture-token'
    })
    await expect(reply.next()).rejects.toThrow('unavailable in the Eris Cloud catalog')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the account catalog in trusted workspaces and honors a workspace Cloud disable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eris-cloud-scope-'))
    try {
      const withCloud = settingsWith(['hidden-tag'], ['local-tag'])
      const cloud = withCloud.models.connections.find(c => c.id === 'eris-cloud')!
      setSettings('user', { models: { connections: withCloud.models.connections } }, root)
      setSettings('workspace', { models: { connections: withCloud.models.connections } }, root)
      const updated = settingsWith(['visible-tag'], ['local-tag'])
      setSettings('user', { models: { connections: updated.models.connections } }, root)

      const resolved = getResolvedSettings(root)
      expect(resolveConnectionForModel(resolved, 'cloud:hidden-tag')).toBeNull()
      expect(resolveConnectionForModel(resolved, 'cloud:visible-tag')?.id).toBe('eris-cloud')
      expect(resolveConnectionForModel(resolved, 'local-tag')?.id).toBe('ollama')

      setSettings('workspace', { models: { connections: [{ ...cloud, enabled: false }] } }, root)
      expect(resolveConnectionForModel(getResolvedSettings(root), 'cloud:visible-tag')).toBeNull()
      expect(resolveConnectionForModel(getResolvedSettings(null), 'cloud:visible-tag')?.id).toBe('eris-cloud')
      const profile = getResolvedSettings(null)
      const status = await getModelsStatus(getResolvedSettings(root), () => null, { probeCloud: true })
      expect(connectionsWithDiscoveredModels(profile, status).changed).toBe(false)

      setSettings('user', { models: { connections: [] } }, root)
      setSettings('workspace', { models: { connections: [cloud] } }, root)
      expect(getResolvedSettings(root).models.connections.find(c => c.id === 'eris-cloud'))
        .toMatchObject({ enabled: false, models: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
