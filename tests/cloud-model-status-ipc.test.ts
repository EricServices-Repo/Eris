import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelsStatus } from '../src/shared/settings-schema'
import { ERIS_CLOUD_BASE_URL, ERIS_CLOUD_TOKEN_REF } from '../src/shared/eris-cloud'

const h = vi.hoisted(() => ({
  handle: vi.fn(),
  getModelsStatus: vi.fn(),
  setSettings: vi.fn(),
  currentWorkspace: '/workspace',
  token: 'account-a',
  enabled: true
}))
vi.mock('electron', async (original) => ({
  ...await original<typeof import('electron')>(), ipcMain: { handle: h.handle }
}))
vi.mock('../electron/main/app-state', () => ({ appState: h }))
vi.mock('../electron/main/ipc/shared', () => ({ getSecret: () => h.token }))
vi.mock('../electron/main/services/model-catalog', () => ({
  getModelsStatus: h.getModelsStatus,
  connectionsWithDiscoveredModels: (_: unknown, status: ModelsStatus) => ({
    connections: status.connections, changed: true
  })
}))
vi.mock('../electron/main/services/settings', () => ({
  getResolvedSettings: () => ({ models: { connections: [{ ...cloud, enabled: h.enabled }] } }),
  setSettings: h.setSettings
}))

import { registerModelsIpc } from '../electron/main/ipc/models'

const cloud = {
  id: 'eris-cloud', name: 'Eris Cloud', type: 'openai-compatible', provider: 'ollama',
  enabled: true, baseUrl: ERIS_CLOUD_BASE_URL, apiKeyRef: ERIS_CLOUD_TOKEN_REF, models: []
} as const

function pendingStatus() {
  let complete!: (status: ModelsStatus) => void
  const promise = new Promise<ModelsStatus>((resolve) => { complete = resolve })
  h.getModelsStatus.mockReturnValueOnce(promise)
  return complete
}

function status(tag: string, local?: string): ModelsStatus {
  return {
    ok: true, builtin: [],
    connections: [{ ...cloud, models: [tag], reachable: true }],
    models: [
      { name: `cloud:${tag}`, connectionId: 'eris-cloud', source: 'connection', ready: true },
      ...(local ? [{ name: local, source: 'local' as const, ready: true }] : [])
    ]
  }
}

function refreshModels(): Promise<ModelsStatus> {
  const handler = h.handle.mock.calls.find(([channel]) => channel === 'models:status')?.[1]
  return handler({}, { probeCloud: true })
}

beforeEach(() => {
  vi.resetAllMocks()
  h.currentWorkspace = '/workspace'
  h.token = 'account-a'
  h.enabled = true
  registerModelsIpc()
})

describe('Cloud catalog refresh IPC', () => {
  it('returns the latest catalog to a superseded caller even if the older probe finishes first', async () => {
    const finishOld = pendingStatus()
    const finishNew = pendingStatus()
    const old = refreshModels()
    const latest = refreshModels()
    finishOld(status('removed', 'local:kept'))
    finishNew(status('available'))

    expect((await latest).models.map(m => m.name)).toEqual(['cloud:available'])
    expect((await old).models.map(m => m.name)).toEqual(['local:kept', 'cloud:available'])
    expect(h.setSettings).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'workspace', 'disabled'] as const)('drops a pending result after the %s changes', async (changed) => {
    const finish = pendingStatus()
    const reply = refreshModels()
    if (changed === 'account') h.token = 'account-b'
    if (changed === 'workspace') h.currentWorkspace = '/different'
    if (changed === 'disabled') h.enabled = false
    finish(status('old'))

    expect(await reply).toMatchObject({ ok: false, connections: [], models: [] })
    expect(h.setSettings).not.toHaveBeenCalled()
  })
})
