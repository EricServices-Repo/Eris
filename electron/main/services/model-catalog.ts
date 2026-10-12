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
  const externalProbes = settings.models.connections.map(async (conn) => {
    if (conn.type === 'builtin') {
      return {
        connection: { ...conn, reachable: builtin.some((b) => b.ready) },
        models: [] as ModelInfo[]
      }
    }
    if (!conn.enabled) {
      return { connection: { ...conn, reachable: false }, models: [] as ModelInfo[] }
    }
    const key = conn.apiKeyRef ? getSecret(conn.apiKeyRef) : null
    try {
      const remote = await listOpenAIModels(conn.baseUrl, key)
      const names = remote.length > 0 ? remote : conn.models
      const discovered: ModelInfo[] = []
      for (const name of names) {
        if (isBuiltinRef(name)) continue
        discovered.push({
          name,
          source: 'connection',
          connectionId: conn.id,
          ready: true
        })
      }
      return {
        connection: { ...conn, reachable: true, models: names },
        models: discovered
      }
    } catch (err) {
      return {
        connection: {
          ...conn,
          reachable: false,
          error: err instanceof Error ? err.message : 'Unreachable'
        },
        models: conn.models.map((name) => ({
          name,
          source: 'connection' as const,
          connectionId: conn.id,
          ready: false
        }))
      }
    }
  })

  for (const result of await Promise.all(externalProbes)) {
    connections.push(result.connection)
    models.push(...result.models)
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
  model: string,
  hintConnectionId?: string | null
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
  if (hintConnectionId) {
    const hinted = external.find((c) => c.id === hintConnectionId)
    if (hinted) return hinted
  }
  const byModel = external.find((c) => c.models.includes(model))
  if (byModel) return byModel

  const ollama = external.find((c) => c.provider === 'ollama' || c.id === 'ollama')
  // Open-ended connection (empty models list = accept any id from that server)
  const openEnded = external.filter((c) => c.models.length === 0)
  if (openEnded.length === 1) return openEnded[0]!
  // Prefer Ollama when the model isn't in any persisted list yet (fresh pull / before Refresh)
  if (ollama) return ollama
  if (external.length === 1) return external[0]!
  return external[0] ?? null
}

/**
 * Compact catalog for agent system prompts — answers “what models do you have?”
 * without searching the workspace. Uses persisted connection lists + builtin status
 * (no network round-trip).
 */
export function formatAvailableModelsPrompt(
  settings: AppSettings,
  selectedModel?: string
): string {
  const lines: string[] = [
    '[Eris AI models — use this list for questions about available / accessible models. Do not search the workspace for “models”.]',
    `Chat selection: ${selectedModel || settings.models.defaultModel || '(none)'}`,
    `Settings default: ${settings.models.defaultModel || '(none)'}`
  ]
  const builtins = getBuiltinStatuses()
  if (builtins.length) {
    lines.push('Built-in Composer:')
    for (const b of builtins) {
      const label = b.ready ? 'ready' : 'not downloaded'
      lines.push(`- ${b.ref} (${label}${b.tier ? `, ${b.tier}` : ''})`)
    }
  }
  const external = settings.models.connections.filter(
    (c) => c.enabled && c.type === 'openai-compatible'
  )
  if (external.length) {
    lines.push('Connected providers (OpenAI-compatible / Ollama):')
    for (const c of external) {
      const names = c.models.length ? c.models : ['(refresh Models in Settings to list)']
      lines.push(`- ${c.name} (${c.provider || c.id}) @ ${c.baseUrl || '?'}`)
      for (const name of names.slice(0, 40)) {
        lines.push(`  · ${name}`)
      }
      if (names.length > 40) lines.push(`  · …+${names.length - 40} more`)
    }
  } else {
    lines.push('No external providers enabled. Add Ollama or an API in Settings → Models.')
  }
  lines.push(
    'Users pick models in the chat picker or Settings → Models. Prefer naming ready models first.'
  )
  return lines.join('\n')
}

/** Persist live /v1/models lists onto connection.models so chat routing stays accurate. */
export function connectionsWithDiscoveredModels(
  settings: AppSettings,
  status: ModelsStatus
): { connections: ModelConnection[]; changed: boolean } {
  let changed = false
  const connections = settings.models.connections.map((c) => {
    if (c.type !== 'openai-compatible' || !c.enabled) return c
    const live = status.connections.find((x) => x.id === c.id)
    if (!live?.reachable || !live.models?.length) return c
    const same =
      c.models.length === live.models.length && c.models.every((m, i) => m === live.models[i])
    if (same) return c
    changed = true
    return { ...c, models: [...live.models] }
  })
  return { connections, changed }
}
