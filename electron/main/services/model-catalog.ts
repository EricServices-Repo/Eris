import type {
  AppSettings,
  ModelConnection,
  ModelInfo,
  ModelsStatus
} from '../../../src/shared/settings-schema'
import { getBuiltinStatuses, isBuiltinRef, resolveReadyBuiltinRef } from './builtin-model'
import { listOpenAIModels } from './openai-compatible'

export async function getModelsStatus(
  settings: AppSettings,
  getSecret: (key: string) => string | null
): Promise<ModelsStatus> {
  const builtin = getBuiltinStatuses()
  const models: ModelInfo[] = builtin.map((b) => ({
    name: b.ref,
    size: b.downloadedBytes || b.approxBytes,
    source: 'builtin' as const,
    ready: b.ready
  }))

  const connections: ModelsStatus['connections'] = []
  for (const conn of settings.models.connections) {
    if (conn.type === 'builtin') {
      connections.push({ ...conn, reachable: builtin.some((b) => b.ready) })
      continue
    }
    if (!conn.enabled) {
      connections.push({ ...conn, reachable: false })
      continue
    }
    const key = conn.apiKeyRef ? getSecret(conn.apiKeyRef) : null
    try {
      const remote = await listOpenAIModels(conn.baseUrl, key)
      const names = remote.length > 0 ? remote : conn.models
      for (const name of names) {
        if (isBuiltinRef(name)) continue
        models.push({
          name,
          source: 'connection',
          connectionId: conn.id,
          ready: true
        })
      }
      connections.push({ ...conn, reachable: true, models: names })
    } catch (err) {
      connections.push({
        ...conn,
        reachable: false,
        error: err instanceof Error ? err.message : 'Unreachable'
      })
      for (const name of conn.models) {
        models.push({
          name,
          source: 'connection',
          connectionId: conn.id,
          ready: false
        })
      }
    }
  }

  const anyBuiltinReady = builtin.some((b) => b.ready)
  const anyConnectionReady = models.some((m) => m.source === 'connection' && m.ready)
  return {
    ok: anyBuiltinReady || anyConnectionReady,
    error: anyBuiltinReady || anyConnectionReady
      ? undefined
      : 'No models ready — download Composer Lite, or add Ollama / a cloud API in Settings → Models',
    builtin,
    models,
    connections
  }
}

export function resolveConnectionForModel(
  settings: AppSettings,
  model: string
): ModelConnection | null {
  if (isBuiltinRef(model)) {
    const ready = resolveReadyBuiltinRef(model)
    return (
      settings.models.connections.find((c) => c.type === 'builtin') ?? {
        id: 'builtin',
        name: 'Built-in Composer',
        type: 'builtin',
        provider: 'builtin',
        enabled: true,
        baseUrl: '',
        apiKeyRef: '',
        models: ready
          ? [ready, 'builtin:composer-lite', 'builtin:composer']
          : ['builtin:composer-lite', 'builtin:composer']
      }
    )
  }
  const external = settings.models.connections.filter(
    (c) => c.enabled && c.type === 'openai-compatible'
  )
  const byModel = external.find((c) => c.models.includes(model))
  if (byModel) return byModel
  // Single open-ended connection (empty models list = discover-all)
  const openEnded = external.filter((c) => c.models.length === 0)
  if (openEnded.length === 1) return openEnded[0]!
  return external[0] ?? null
}
