import { CONNECT_MODEL_MESSAGE } from '../../../src/shared/model-setup'
import { migrateRetiredModel } from '../../../src/shared/legacy-model-ref'
import {
  connectionModelRef,
  isErisCloudConnection,
  isErisCloudModelRef,
  isLocalOllamaConnection,
  providerModelId
} from '../../../src/shared/eris-cloud'
import type {
  AppSettings,
  ModelConnection,
  ModelInfo,
  ModelsStatus
} from '../../../src/shared/settings-schema'
import { getBuiltinStatuses, isBuiltinRef, resolveReadyBuiltinRef } from './builtin-model'
import { getLocalStatuses, isLocalRef } from './local-model'
import { listOpenAIModels } from './openai-compatible'
import { getGpuAccelStatus } from './gpu-accel'
import { isOllamaConnection, placementsFor, probeOllamaModel, resetOllamaFit } from './ollama-runtime'

export type ModelsStatusOptions = {
  /**
   * When true, hit every OpenAI-compatible / Ollama `/v1/models` endpoint (slow).
   * Default false — use persisted connection.models for chat/boot hot paths.
   */
  probeConnections?: boolean
  /** Refresh only the account-scoped Eris Cloud catalog. */
  probeCloud?: boolean
  /** Include GPU accel probe (Settings). Default false on light paths. */
  includeGpu?: boolean
  /** Connection id whose fitted Ollama windows to forget, so the next load re-measures (#677). */
  resetContextFit?: string
}

function catalogModels(
  builtin: ReturnType<typeof getBuiltinStatuses>,
  local: ReturnType<typeof getLocalStatuses>
): ModelInfo[] {
  return [
    ...builtin.map((b) => ({
      name: b.ref,
      size: b.downloadedBytes || b.approxBytes,
      source: 'builtin' as const,
      ready: b.ready
    })),
    ...local.map((m) => ({
      name: m.ref,
      size: m.downloadedBytes || m.approxBytes,
      source: 'local' as const,
      ready: m.ready
    }))
  ]
}

/** Fast path: disk catalog + persisted connection lists (no network). */
function lightConnectionSnapshot(
  configured: readonly ModelConnection[],
  builtinReady: boolean
): { connections: ModelsStatus['connections']; models: ModelInfo[] } {
  const connections: ModelsStatus['connections'] = []
  const models: ModelInfo[] = []
  for (const conn of configured) {
    if (conn.type === 'builtin') {
      connections.push({ ...conn, reachable: builtinReady })
      continue
    }
    if (!conn.enabled) {
      connections.push({ ...conn, reachable: false })
      continue
    }
    // Optimistic: listed models are usable without a live probe (chat send / boot).
    connections.push({ ...conn, reachable: true })
    for (const name of conn.models) {
      if (isBuiltinRef(name) || isLocalRef(name)) continue
      models.push({
        name: connectionModelRef(conn, name),
        source: 'connection',
        connectionId: conn.id,
        provider: conn.provider,
        ready: true
      })
    }
  }
  return { connections, models }
}

export async function getModelsStatus(
  settings: AppSettings,
  getSecret: (key: string) => string | null,
  options: ModelsStatusOptions = {}
): Promise<ModelsStatus> {
  const probeConnections = options.probeConnections === true
  const includeGpu = options.includeGpu === true
  if (options.resetContextFit) {
    const target = settings.models.connections.find((c) => c.id === options.resetContextFit)
    if (target && isOllamaConnection(target)) resetOllamaFit(target)
  }
  const preferEgpu = settings.models.preferEgpu !== false

  const builtin = getBuiltinStatuses()
  const local = getLocalStatuses()
  const models = catalogModels([], local)
  const gpu = includeGpu ? await getGpuAccelStatus(preferEgpu) : undefined

  let connections: ModelsStatus['connections'] = []

  if (!probeConnections && !options.probeCloud) {
    const snap = lightConnectionSnapshot(
      settings.models.connections,
      builtin.some((b) => b.ready)
    )
    connections = snap.connections
    models.push(...snap.models)
  } else {
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
      const cloud = isErisCloudConnection(conn)
      if (!probeConnections && !cloud) {
        const snap = lightConnectionSnapshot([conn], false)
        return { connection: snap.connections[0]!, models: snap.models }
      }
      const key = conn.apiKeyRef ? getSecret(conn.apiKeyRef) : null
      try {
        if (cloud && !key) throw new Error('Sign in to EricServic.es to see Eris Cloud models.')
        const remote = await listOpenAIModels(conn.baseUrl, key)
        const names = cloud || remote.length > 0 ? remote : conn.models
        if (probeConnections && isOllamaConnection(conn)) {
          // Explicit refresh populates a bounded set of routing facts. Models not
          // refreshed here still use bundled or size-based evidence until first use.
          await Promise.all(names.slice(0, 6).map((name) => probeOllamaModel(conn, connectionModelRef(conn, name), key)))
        }
        const discovered: ModelInfo[] = []
        for (const name of names) {
          if (isBuiltinRef(name) || isLocalRef(name)) continue
          discovered.push({
            name: connectionModelRef(conn, name),
            source: 'connection',
            connectionId: conn.id,
        provider: conn.provider,
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
            ...(cloud ? { models: [] } : {}),
            reachable: false,
            error: err instanceof Error ? err.message : 'Unreachable'
          },
          models: (cloud ? [] : conn.models).map((name) => ({
            name: connectionModelRef(conn, name),
            source: 'connection' as const,
            connectionId: conn.id,
        provider: conn.provider,
            ready: false
          }))
        }
      }
    })

    for (const result of await Promise.all(externalProbes)) {
      connections.push(result.connection)
      models.push(...result.models)
    }
  }

  const anyLocalReady = local.some((m) => m.ready)
  const anyConnectionReady = models.some((m) => m.source === 'connection' && m.ready)
  return {
    ok: anyLocalReady || anyConnectionReady,
    error:
      anyLocalReady || anyConnectionReady
        ? undefined
        : CONNECT_MODEL_MESSAGE,
    builtin,
    local,
    models,
    connections: connections.map((connection) => {
      const placements = placementsFor(connection)
      return placements.length ? { ...connection, placements } : connection
    }),
    gpu
  }
}

export function resolveConnectionForModel(
  settings: AppSettings,
  model: string,
  hintConnectionId?: string | null
): ModelConnection | null {
  if (isBuiltinRef(model) || isLocalRef(model)) {
    const ready = isBuiltinRef(model) ? resolveReadyBuiltinRef(model) : model
    return (
      settings.models.connections.find((c) => c.type === 'builtin') ?? {
        id: 'builtin',
        name: isLocalRef(model) ? 'Local GGUF' : 'Built-in Composer',
        type: 'builtin',
        provider: isLocalRef(model) ? 'local' : 'builtin',
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
  // `cloud:<model>` always means the hosted Eris Cloud server, never another connection.
  if (isErisCloudModelRef(model)) {
    return external.find((c) => isErisCloudConnection(c) && c.models.some((name) =>
      providerModelId(name) === providerModelId(model))) ?? null
  }
  if (hintConnectionId) {
    const hinted = external.find((c) => c.id === hintConnectionId &&
      (!isErisCloudConnection(c) || c.models.includes(model)))
    if (hinted) return hinted
  }
  // A bare id is the user's own connection first; Eris Cloud only for an older saved
  // selection made before hosted models carried the `cloud:` prefix.
  const byModel =
    external.find((c) => !isErisCloudConnection(c) && c.models.includes(model)) ??
    external.find((c) => c.models.includes(model))
  if (byModel) return byModel

  // Eris Cloud is a closed catalog. Only generic connections may accept unlisted IDs.
  const generic = external.filter((c) => !isErisCloudConnection(c))
  const ollama =
    generic.find((c) => isLocalOllamaConnection(c)) ??
    generic.find((c) => c.provider === 'ollama' || c.id === 'ollama')
  // Open-ended connection (empty models list = accept any id from that server)
  const openEnded = generic.filter((c) => c.models.length === 0)
  if (openEnded.length === 1) return openEnded[0]!
  // Prefer Ollama when the model isn't in any persisted list yet (fresh pull / before Refresh)
  if (ollama) return ollama
  return generic[0] ?? null
}

/**
 * Compact catalog for agent system prompts — answers “what models do you have?”
 * without searching the workspace. Uses persisted connection lists and the local GGUF catalog
 * (no network round-trip).
 */
export function formatAvailableModelsPrompt(settings: AppSettings, selectedModel?: string): string {
  const lines: string[] = [
    '[Eris AI models — use this list for questions about available / accessible models. Do not search the workspace for “models”.]',
    `Chat selection: ${migrateRetiredModel(selectedModel || settings.models.defaultModel) || '(none)'}`,
    `Settings default: ${migrateRetiredModel(settings.models.defaultModel) || '(none)'}`
  ]
  const locals = getLocalStatuses()
  if (locals.length) {
    lines.push('Local models (run inside Eris, no Ollama):')
    for (const m of locals) {
      lines.push(`- ${m.ref} (${m.ready ? 'ready' : 'not downloaded'})`)
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
  status: ModelsStatus,
  options: { cloudOnly?: boolean } = {}
): { connections: ModelConnection[]; changed: boolean } {
  let changed = false
  const connections = settings.models.connections.map((c) => {
    if (c.type !== 'openai-compatible' || !c.enabled) return c
    const cloud = isErisCloudConnection(c)
    if (options.cloudOnly && !cloud) return c
    const live = status.connections.find((x) => x.id === c.id)
    if (!live?.enabled || live.baseUrl !== c.baseUrl || (!cloud && (!live.reachable || !live.models.length))) return c
    const same =
      c.models.length === live.models.length && c.models.every((m, i) => m === live.models[i])
    if (same) return c
    changed = true
    return { ...c, models: [...live.models] }
  })
  return { connections, changed }
}
