import { totalmem } from 'node:os'
import type { ModelConnection } from '../../../src/shared/settings-schema'
import type { DetectedModelService, LocalModelServiceId, ModelSetupOptions } from '../../../src/shared/model-setup'
import { getLocalStatuses } from './local-model'
import { getResolvedSettings, setSettings } from './settings'

const localServices = {
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' }
} satisfies Record<LocalModelServiceId, Pick<ModelConnection, 'name' | 'baseUrl'>>

export async function detectLocalModelService(
  id: LocalModelServiceId,
  fetchModels: typeof fetch = fetch
): Promise<DetectedModelService | null> {
  const service = localServices[id]
  try {
    const response = await fetchModels(`${service.baseUrl}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(1800),
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    const body = await response.json() as { data?: unknown }
    if (!Array.isArray(body.data)) return null
    const models = body.data.flatMap((entry: { id?: unknown } | null) =>
      typeof entry?.id === 'string' && entry.id.trim() ? [entry.id.trim()] : []
    )
    return { id, name: service.name, models: [...new Set(models)] }
  } catch {
    return null
  }
}

export async function getModelSetupOptions(): Promise<ModelSetupOptions> {
  const services = await Promise.all([
    detectLocalModelService('ollama'),
    detectLocalModelService('lmstudio')
  ])
  const recommendation = totalmem() >= 16 * 1024 ** 3 ? 'qwen25-coder-7b' : 'qwen25-coder-3b'
  const model = getLocalStatuses().find((entry) => entry.id === recommendation)
  return {
    services: services.filter((service) => service !== null),
    recommended: model ? { id: model.id, name: model.name, sizeLabel: model.sizeLabel } : null
  }
}

export async function connectDetectedModelService(id: string, workspacePath: string | null): Promise<void> {
  if (id !== 'ollama' && id !== 'lmstudio') throw new Error('Unknown local model service.')
  const detected = await detectLocalModelService(id)
  if (!detected) throw new Error(`Start ${localServices[id].name} and try again.`)
  const service = localServices[id]
  // Update only the user catalog so a workspace overlay cannot leak into user settings.
  const connections = getResolvedSettings(null).models.connections
  const existing = connections.find((connection) => connection.baseUrl.replace(/\/$/, '') === service.baseUrl)
  const connectionId = existing?.id ?? (connections.some((item) => item.id === id) ? `${id}-loopback` : id)
  if (!existing && connections.some((item) => item.id === connectionId))
    throw new Error('This provider ID is already in use. Connect the server in Settings → Providers.')
  const connection: ModelConnection = {
    ...existing,
    ...service,
    id: connectionId,
    type: 'openai-compatible',
    provider: id,
    enabled: true,
    apiKeyRef: existing?.apiKeyRef ?? '',
    models: detected.models
  }
  setSettings('user', { models: {
    connections: [...connections.filter((item) => item.id !== connectionId), connection]
  } }, workspacePath)
}
