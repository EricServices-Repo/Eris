import { usesModelMaximum, parameterBillions, type ModelCapabilityEvidence } from '../../../src/shared/model-capability-profile'
import { providerContext } from './provider-context'
import { MAX_CONTEXT_TOKENS, boundedContextWindow } from '../../../src/shared/model-context'
import { logWarn } from './logger'
import { ollamaNativeHost } from './ollama'
import { resolveConnectionForModel } from './model-catalog'
import { isLoopbackUrl } from '../../../src/shared/model-destination'
import { isErisCloudConnection, providerModelId } from '../../../src/shared/eris-cloud'
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

type Probe = { maxContext: number | null; at: number; capabilities?: ModelCapabilityEvidence }
const probes = new Map<string, Probe>()
const placements = new Map<string, OllamaPlacement>()
const key = (connection: ModelConnection, model: string) =>
  `${ollamaNativeHost(connection.baseUrl)}\n${providerModelId(model)}`

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
  let capabilities: ModelCapabilityEvidence | undefined
  try {
    const body = await apiRequest(connection, '/api/show', apiKey, { model: providerModelId(model) }, signal)
    maxContext = contextLengthOf(body)
    const data = body as { capabilities?: unknown; details?: { parameter_size?: unknown } } | null
    const flags = Array.isArray(data?.capabilities) ? data.capabilities : null
    const parametersBillions = parameterBillions(data?.details?.parameter_size)
    capabilities = {
      ...(maxContext ? { contextWindow: boundedContextWindow(Math.min(maxContext, MAX_CONTEXT_TOKENS)) } : {}),
      ...(flags ? {
        toolCalling: flags.includes('tools') ? 'native' : flags.includes('completion') ? 'text' : 'none',
        reasoning: flags.includes('thinking'),
        vision: flags.includes('vision')
      } : {}),
      ...(parametersBillions === undefined ? {} : { parametersBillions })
    }
  } catch {
    /* Recorded below: the route and window stay unverified. */
  }
  probes.set(key(connection, model), { maxContext, at: Date.now(), capabilities })
}

export function ollamaCapabilityEvidence(connection: ModelConnection, model: string) {
  const probe = probes.get(key(connection, model))
  return probe && Date.now() - probe.at <= FACTS_TTL_MS ? probe.capabilities : undefined
}

/** Prepare model metadata before any budget is computed. Cancellation propagates. */
export async function prepareModelWindows(
  settings: AppSettings,
  models: readonly string[],
  getSecret: (key: string) => string | null,
  signal?: AbortSignal
): Promise<void> {
  await Promise.all(
    [...new Set(models)].map(async (model) => {
      signal?.throwIfAborted()
      if (model.startsWith('builtin:') || model.startsWith('local:')) {
        const { prepareNativeModelWindow } = await import('./builtin-model')
        await prepareNativeModelWindow(model, signal)
        return
      }
      const connection = resolveConnectionForModel(settings, model)
      if (!connection || !isOllamaConnection(connection)) return
      const apiKey = connection.apiKeyRef ? getSecret(connection.apiKeyRef) : null
      await probeOllamaModel(connection, model, apiKey, signal)
    })
  )
}

const windowFor = (requested: number, maxContext: number) =>
  boundedContextWindow(requested, Math.min(maxContext, MAX_CONTEXT_TOKENS))

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

/** Endpoint-scoped user declarations; never infer capacity from a model name. */
export function declaredModelLimits(settings: AppSettings, model: string) {
  return resolveConnectionForModel(settings, model)?.modelLimits?.[providerModelId(model)]
}

export function advertisedModelLimits(settings: AppSettings, model: string) {
  const connection = resolveConnectionForModel(settings, model)
  return connection && providerContext(connection.baseUrl, providerModelId(model))
}

/** What this server gives a request. Null leaves the caller's ceiling for hosted providers. */
export function serverWindow(settings: AppSettings, model: string, requested: number) {
  const connection = resolveConnectionForModel(settings, model)
  if (connection?.type !== 'openai-compatible') return null
  const advertised = providerContext(connection.baseUrl, providerModelId(model))
  if (advertised && !isOllamaConnection(connection))
    return {
      contextCeiling: boundedContextWindow(requested, advertised.contextWindow),
      contextSource: 'provider-declared' as const
    }
  const target = ollamaRequestWindow(connection, model, requested)
  if (target === null)
    return isLocalServer(connection) && !connection.modelLimits?.[providerModelId(model)]
      ? {
          contextCeiling: Math.min(UNVERIFIED_WINDOW, Math.max(512, requested)),
          contextSource: 'unverified-window' as const
        }
      : null
  const placement = ollamaPlacement(connection, model)
  // Strict maximum mode is validated live before dispatch, never silently fitted down.
  if (usesModelMaximum(settings, model) && placement?.loadedWindow !== target)
    return { contextCeiling: target, contextSource: 'runtime-plan' as const }
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
    const id = providerModelId(model)
    const loaded = body.models?.find((item) => item.name === id || item.model === id)
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

/** A reported model limit, never an inference from the model's name or GPU size. */
export function ollamaMaximumContext(settings: AppSettings, model: string, required = true): number | undefined {
  const connection = resolveConnectionForModel(settings, model)
  if (!connection || !isOllamaConnection(connection) || isErisCloudConnection(connection)) {
    if (!required) return undefined
    throw new Error('Use model maximum requires a direct Ollama connection. Select a configured limit for this provider.')
  }
  const probe = probes.get(key(connection, model))
  const maximum = probe && Date.now() - probe.at <= FACTS_TTL_MS ? probe.maxContext : undefined
  if (!maximum || maximum < 512) {
    if (!required) return undefined
    throw new Error(`Cannot read the maximum context for ${model} from Ollama. Refresh the connection or select a configured limit.`)
  }
  return Math.min(maximum, MAX_CONTEXT_TOKENS)
}

/** Validate immediately before prompt packing/dispatch; old diagnostic records are insufficient. */
export async function ensureMaximumContextAllocation(
  settings: AppSettings,
  model: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<void> {
  if (!usesModelMaximum(settings, model)) return
  const maximum = ollamaMaximumContext(settings, model)!
  const connection = resolveConnectionForModel(settings, model)!
  const loadedWindow = async () => {
    const body = await apiRequest(connection, '/api/ps', apiKey, undefined, signal) as {
      models?: Array<{ name?: string; model?: string; context_length?: number }>
    }
    const id = providerModelId(model)
    return body.models?.find((item) => item.name === id || item.model === id)?.context_length
  }
  try {
    if (await loadedWindow() === maximum) {
      await observeOllamaPlacement(connection, model, maximum, apiKey)
      return
    }
    // An empty native chat loads the requested runner without sending conversation data.
    const timeout = AbortSignal.timeout(10 * 60_000)
    const response = await fetch(`${ollamaNativeHost(connection.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: providerModelId(model), messages: [], stream: false,
        options: { num_ctx: maximum },
        keep_alive: connection.keepModelLoaded ? KEEP_LOADED_INDEFINITELY : ACTIVE_SESSION_KEEP_ALIVE
      }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    if (!response.ok) throw new Error(`Ollama load failed (HTTP ${response.status})`)
    const result = await response.json() as { error?: string }
    if (result.error) throw new Error(result.error)
    const loaded = await loadedWindow()
    if (loaded !== maximum)
      throw new Error(`requested ${maximum.toLocaleString()} tokens, loaded ${loaded?.toLocaleString() ?? 'an unreported window'}`)
    await observeOllamaPlacement(connection, model, maximum, apiKey)
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(`Cannot allocate the maximum context for ${model} (${maximum.toLocaleString()} tokens): ${error instanceof Error ? error.message : String(error)}. Check server memory and parallel slots, or select a configured limit.`, { cause: error })
  }
}
