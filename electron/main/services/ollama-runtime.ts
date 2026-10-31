import { logWarn } from './logger'
import { ollamaNativeHost } from './ollama'
import { resolveConnectionForModel } from './model-catalog'
import { isLoopbackUrl } from '../../../src/shared/model-destination'
import type { AppSettings, ModelConnection } from '../../../src/shared/settings-schema'

const FACTS_TTL_MS = 5 * 60_000
const FAILED_PROBE_TTL_MS = 15_000
const PROBE_TIMEOUT_MS = 1_500
/** Used for local servers whose window cannot be read. Well under the 32K setting default. */
export const UNVERIFIED_WINDOW = 8192
/** Outlives Ollama's 5m default, so a pause in an active session avoids a cold reload. */
export const ACTIVE_SESSION_KEEP_ALIVE = '30m'
export const KEEP_LOADED_INDEFINITELY = -1

/** What Ollama reported after a request; `requestedWindow` ties it to that request. */
export type OllamaPlacement = {
  model: string
  requestedWindow: number
  /** Absent on server versions whose /api/ps omits it. */
  loadedWindow?: number
  sizeBytes: number
  vramBytes: number
}

type Probe = { maxContext: number | null; at: number }
const probes = new Map<string, Probe>()
const placements = new Map<string, OllamaPlacement>()
const key = (connection: ModelConnection, model: string) =>
  `${ollamaNativeHost(connection.baseUrl)}\n${model}`

export function clearOllamaRuntimeFacts(): void {
  probes.clear()
  placements.clear()
}

/** A label only nominates a server; /api/show must still answer before it is used. */
export const isOllamaConnection = (connection: ModelConnection) =>
  connection.type === 'openai-compatible' &&
  (connection.provider === 'ollama' || connection.id === 'ollama')

const isLocalServer = (connection: ModelConnection) =>
  isOllamaConnection(connection) ||
  connection.provider === 'lmstudio' ||
  isLoopbackUrl(connection.baseUrl)

function contextLengthOf(body: unknown): number | null {
  const info = (body as { model_info?: unknown } | null)?.model_info
  if (!info || typeof info !== 'object') return null
  const fields = info as Record<string, unknown>
  const architecture = fields['general.architecture']
  const exact = fields[`${String(architecture)}.context_length`]
  const value =
    exact ?? Object.entries(fields).find(([name]) => name.endsWith('.context_length'))?.[1]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

async function apiRequest(
  connection: ModelConnection,
  path: string,
  apiKey: string | null,
  body?: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const response = await fetch(`${ollamaNativeHost(connection.baseUrl)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** Read a model's window from the server, so synchronous budgets can use it. */
export async function probeOllamaModel(
  connection: ModelConnection,
  model: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<void> {
  const known = probes.get(key(connection, model))
  const ttl = known?.maxContext ? FACTS_TTL_MS : FAILED_PROBE_TTL_MS
  if (known && Date.now() - known.at < ttl) return
  let maxContext: number | null = null
  try {
    maxContext = contextLengthOf(
      await apiRequest(connection, '/api/show', apiKey, { model }, signal)
    )
  } catch {
    /* Recorded below: the route and window stay unverified. */
  }
  probes.set(key(connection, model), { maxContext, at: Date.now() })
}

/** Probe the models a turn will use, before any budget is computed. Never throws. */
export async function prepareModelWindows(
  settings: AppSettings,
  models: readonly string[],
  getSecret: (key: string) => string | null,
  signal?: AbortSignal
): Promise<void> {
  await Promise.all(
    [...new Set(models)].map(async (model) => {
      const connection = resolveConnectionForModel(settings, model)
      if (!connection || !isOllamaConnection(connection)) return
      const apiKey = connection.apiKeyRef ? getSecret(connection.apiKeyRef) : null
      await probeOllamaModel(connection, model, apiKey, signal)
    })
  )
}

const windowFor = (requested: number, maxContext: number) =>
  Math.min(128000, Math.max(512, requested), maxContext)

/** The `num_ctx` for a verified Ollama model, or null to use the OpenAI-compatible route. */
export function ollamaRequestWindow(
  connection: ModelConnection,
  model: string,
  requested: number
): number | null {
  if (!isOllamaConnection(connection)) return null
  const maxContext = probes.get(key(connection, model))?.maxContext
  return maxContext ? windowFor(requested, maxContext) : null
}

export function ollamaPlacement(connection: ModelConnection, model: string) {
  return placements.get(key(connection, model))
}

export const placementsFor = (connection: ModelConnection) =>
  [...placements.entries()]
    .filter(([name]) => name.startsWith(`${ollamaNativeHost(connection.baseUrl)}\n`))
    .map(([, placement]) => placement)

export const isPartlyOnCpu = (placement: OllamaPlacement) =>
  placement.sizeBytes > 0 && placement.vramBytes < placement.sizeBytes

/** What this server gives a request. Null leaves the caller's ceiling for hosted providers. */
export function serverWindow(settings: AppSettings, model: string, requested: number) {
  const connection = resolveConnectionForModel(settings, model)
  if (connection?.type !== 'openai-compatible') return null
  const target = ollamaRequestWindow(connection, model, requested)
  if (target === null)
    return isLocalServer(connection)
      ? {
          contextCeiling: Math.min(UNVERIFIED_WINDOW, Math.max(512, requested)),
          contextSource: 'unverified-window' as const
        }
      : null
  const placement = ollamaPlacement(connection, model)
  // A record from an earlier num_ctx says nothing about this request's window.
  return placement?.loadedWindow && placement.requestedWindow === target
    ? {
        contextCeiling: Math.min(target, placement.loadedWindow),
        contextSource: 'measured-allocation' as const
      }
    : { contextCeiling: target, contextSource: 'runtime-plan' as const }
}

/** Requested, loaded and placed, for one line of diagnostics. */
export function serverWindowFacts(settings: AppSettings, model: string) {
  const connection = resolveConnectionForModel(settings, model)
  const placement = connection ? ollamaPlacement(connection, model) : undefined
  return (
    placement && { requested: placement.requestedWindow, loaded: placement.loadedWindow, placement }
  )
}

/** Record where the server put the model. Runs after a request, so a miss costs nothing. */
export async function observeOllamaPlacement(
  connection: ModelConnection,
  model: string,
  requestedWindow: number,
  apiKey: string | null
): Promise<void> {
  try {
    const body = (await apiRequest(connection, '/api/ps', apiKey)) as {
      models?: Array<{
        name?: string
        model?: string
        size?: number
        size_vram?: number
        context_length?: number
      }>
    }
    const loaded = body.models?.find((item) => item.name === model || item.model === model)
    if (!loaded || typeof loaded.size !== 'number' || typeof loaded.size_vram !== 'number') return
    const placement: OllamaPlacement = {
      model,
      requestedWindow,
      sizeBytes: loaded.size,
      vramBytes: loaded.size_vram,
      ...(typeof loaded.context_length === 'number' ? { loadedWindow: loaded.context_length } : {})
    }
    placements.set(key(connection, model), placement)
    if (isPartlyOnCpu(placement))
      logWarn('Ollama model is partly on CPU', {
        model,
        vramShare: placement.vramBytes / placement.sizeBytes
      })
  } catch {
    /* Diagnostics only: an unanswered /api/ps must not fail a finished request. */
  }
}
