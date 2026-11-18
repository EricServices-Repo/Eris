import { usesModelMaximum, parameterBillions, type ModelCapabilityEvidence } from '../../../src/shared/model-capability-profile'
import { providerContext } from './provider-context'
import { MAX_CONTEXT_TOKENS, boundedContextWindow } from '../../../src/shared/model-context'
import { logWarn } from './logger'
import { ollamaNativeHost } from './ollama'
import { resolveConnectionForModel } from './model-catalog'
import { isLoopbackUrl } from '../../../src/shared/model-destination'
import { isErisCloudConnection, providerModelId } from '../../../src/shared/eris-cloud'
import { getGpuAccelStatus, lastGpuAccelStatus } from './gpu-accel'
import {
  estimateKvBytesPerToken,
  fitAfterOutOfMemory,
  fitAfterSpill,
  gibToBytes,
  learnedKvBytesPerToken,
  planWindowForBudget,
  type FitReason,
  type KvCacheType,
  type WindowFit
} from './ollama-context-fit'
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
  /** The window Eris now sends instead of the requested one (#677). */
  fittedWindow?: number
  fitReason?: FitReason
  /** An observed load still spills at the minimum supported context. */
  minimumWindowSpills?: boolean
}

type Probe = {
  maxContext: number | null
  at: number
  capabilities?: ModelCapabilityEvidence
  /** `model_info`, kept for the KV cache estimate under the connection's cache type. */
  modelInfo?: Record<string, unknown>
}
const probes = new Map<string, Probe>()
const placements = new Map<string, OllamaPlacement>()
/**
 * Fitted windows, scoped to the requested window they replace and the settings they used.
 * A spill fit keeps the load it was computed from and the per-token cost it used, so it can
 * be recomputed once a measured cost replaces the estimate.
 */
type FitRecord = WindowFit & {
  requested: number
  signature: string
  spillAt?: { window: number; sizeBytes: number; vramBytes: number }
  bytesPerToken?: number | null
}
const fits = new Map<string, FitRecord>()
/** A fit made under other fit settings no longer applies. */
const fitSignature = (connection: ModelConnection) =>
  `${connection.contextFit ?? 'fit'}|${connection.kvCacheType ?? 'f16'}|${connection.vramGiB ?? ''}`
function currentFit(connection: ModelConnection, model: string, base: number) {
  const fit = fits.get(key(connection, model))
  return fit && fit.requested === base && fit.signature === fitSignature(connection) ? fit : undefined
}
/** Total size at each loaded window, newest last, for a measured per-token cost. */
const loads = new Map<string, { signature: string; samples: Array<{ window: number; sizeBytes: number }> }>()
const learnedCost = new Map<string, { signature: string; bytes: number }>()
function measuredKvCost(connection: ModelConnection, model: string): number | undefined {
  const learned = learnedCost.get(key(connection, model))
  return learned?.signature === fitSignature(connection) ? learned.bytes : undefined
}
const key = (connection: ModelConnection, model: string) =>
  `${ollamaNativeHost(connection.baseUrl)}\n${providerModelId(model)}`

export function clearOllamaRuntimeFacts(): void {
  probes.clear()
  placements.clear()
  fits.clear()
  loads.clear()
  learnedCost.clear()
}

/** Forget fitted windows and measurements for one server, so the next load re-measures. */
export function resetOllamaFit(connection: ModelConnection): void {
  const prefix = `${ollamaNativeHost(connection.baseUrl)}\n`
  for (const map of [fits, loads, learnedCost, placements] as Array<Map<string, unknown>>)
    for (const name of [...map.keys()]) if (name.startsWith(prefix)) map.delete(name)
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
  let modelInfo: Record<string, unknown> | undefined
  try {
    const body = await apiRequest(connection, '/api/show', apiKey, { model: providerModelId(model) }, signal)
    maxContext = contextLengthOf(body)
    const info = (body as { model_info?: unknown } | null)?.model_info
    if (info && typeof info === 'object') modelInfo = info as Record<string, unknown>
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
  probes.set(key(connection, model), { maxContext, at: Date.now(), capabilities, modelInfo })
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

/** How Eris sizes `num_ctx` on this connection. Eris Cloud is never fitted: its memory is not ours. */
export function contextFitMode(connection: ModelConnection): 'fit' | 'max' | 'off' {
  if (!isOllamaConnection(connection) || isErisCloudConnection(connection)) return 'off'
  return connection.contextFit ?? 'fit'
}

/**
 * The user chose this model's window, so `max` must not grow past it: a per-model limit on
 * the connection, or a capability profile whose window differs from the global setting.
 * (Saving a profile for its tier also saves a window, usually the global one.)
 */
export function requestedIsExplicit(settings: AppSettings, model: string): boolean {
  if (declaredModelLimits(settings, model)?.contextWindow) return true
  const profile = settings.models.capabilityProfiles?.[model]
  return Boolean(
    profile &&
      profile.enabled !== false &&
      profile.contextWindow &&
      profile.contextWindow !== settings.models.contextWindow
  )
}

/**
 * The `num_ctx` for a verified Ollama model, or null to use the OpenAI-compatible route.
 * Prompt budgets (`serverWindow`) and the request both read this, so they always agree.
 */
export function ollamaRequestWindow(
  connection: ModelConnection,
  model: string,
  requested: number,
  options: { explicit?: boolean; modelMaximum?: boolean } = {}
): number | null {
  if (!isOllamaConnection(connection)) return null
  const maxContext = probes.get(key(connection, model))?.maxContext
  if (!maxContext) return null
  const base = windowFor(requested, maxContext)
  const mode = contextFitMode(connection)
  if (mode === 'off' || options.modelMaximum) return base
  const fit = currentFit(connection, model, base)
  if (!fit) return base
  // A plan may grow the window only in `max` mode and only when the user set no window.
  if (fit.window > base && (mode !== 'max' || options.explicit)) return base
  return Math.min(fit.window, maxContext)
}

export function ollamaPlacement(connection: ModelConnection, model: string) {
  return placements.get(key(connection, model))
}

export const placementsFor = (connection: ModelConnection) =>
  [...placements.entries()]
    .filter(([name]) => name.startsWith(`${ollamaNativeHost(connection.baseUrl)}\n`))
    .map(([name, placement]) => {
      const fit = fits.get(name)
      return fit && fit.signature === fitSignature(connection)
        ? {
            ...placement,
            fittedWindow: fit.window,
            fitReason: fit.reason,
            ...(fit.minimumWindowSpills ? { minimumWindowSpills: true } : {})
          }
        : placement
    })

/** KV cache bytes per token: measured across two loads, else estimated from `/api/show`. */
export function kvBytesPerToken(connection: ModelConnection, model: string): number | null {
  return (
    measuredKvCost(connection, model) ??
    estimateKvBytesPerToken(probes.get(key(connection, model))?.modelInfo, (connection.kvCacheType ?? 'f16') as KvCacheType)
  )
}

/** VRAM the server may use: the declared amount, else this computer's GPUs for a loopback server. */
export function serverVramBudget(
  connection: ModelConnection
): { bytes: number; gpuCount: number } | null {
  if (connection.vramGiB) return { bytes: gibToBytes(connection.vramGiB), gpuCount: 1 }
  if (!isLoopbackUrl(connection.baseUrl)) return null
  const gpu = lastGpuAccelStatus()
  if (!gpu) return null
  // Ollama owns layer placement. Native GGUF's sharing flags and minimum-card
  // threshold do not describe which GPUs this server can use.
  const discrete = gpu.devices.filter((device) =>
    (device.kind === 'discrete' || device.kind === 'external') &&
    typeof device.vramBytes === 'number' && device.vramBytes > 0)
  if (discrete.length) {
    return {
      bytes: discrete.reduce((total, device) => total + device.vramBytes!, 0),
      gpuCount: discrete.length
    }
  }
  // Unified memory is one pool, even when several integrated adapters are listed.
  const bytes = gpu.preferredGpu?.vramBytes
  return bytes ? { bytes, gpuCount: 1 } : null
}

function recordLoad(connection: ModelConnection, model: string, window: number, sizeBytes: number) {
  const name = key(connection, model)
  const signature = fitSignature(connection)
  const previous = loads.get(name)
  const seen = (previous?.signature === signature ? previous.samples : [])
    .filter((item) => item.window !== window)
  seen.push({ window, sizeBytes })
  loads.set(name, { signature, samples: seen.slice(-4) })
  if (seen.length < 2) return
  const learned = learnedKvBytesPerToken(seen[seen.length - 2]!, seen[seen.length - 1]!)
  if (learned) learnedCost.set(name, { signature, bytes: learned })
}

/** After a load: shrink a window that spilled, or plan the largest one that fits (`max`). */
function updateFit(
  connection: ModelConnection,
  model: string,
  placement: OllamaPlacement,
  request: { requested: number; explicit: boolean; modelMaximum?: boolean }
) {
  const mode = contextFitMode(connection)
  const name = key(connection, model)
  const maxContext = probes.get(name)?.maxContext
  if (mode === 'off' || request.modelMaximum || !maxContext) return
  const window = placement.loadedWindow ?? placement.requestedWindow
  recordLoad(connection, model, window, placement.sizeBytes)
  const base = windowFor(request.requested, maxContext)
  const bytesPerToken = kvBytesPerToken(connection, model)
  const current = currentFit(connection, model, base)
  const signature = fitSignature(connection)
  if (placement.vramBytes < placement.sizeBytes) {
    const fit = fitAfterSpill({
      requested: base,
      window,
      sizeBytes: placement.sizeBytes,
      vramBytes: placement.vramBytes,
      bytesPerToken
    })
    if (!fit) return
    fits.set(name, {
      ...fit,
      requested: base,
      signature,
      spillAt: { window, sizeBytes: placement.sizeBytes, vramBytes: placement.vramBytes },
      bytesPerToken
    })
    logWarn('Ollama window fitted to VRAM', {
      model,
      requested: base,
      loaded: window,
      fitted: fit.window,
      minimumWindowSpills: fit.minimumWindowSpills === true
    })
    return
  }
  // An estimated cost can be wrong either way (sliding-window and compressed caches, a
  // parallel-slot server). Once a cost is measured, recompute the spill fit from the load
  // that spilled. This runs at most once per fit, so it cannot oscillate.
  const measured = measuredKvCost(connection, model)
  if (current?.spillAt && measured && current.bytesPerToken !== measured) {
    const refit = fitAfterSpill({ requested: base, ...current.spillAt, bytesPerToken: measured })
    if (refit) {
      fits.set(name, { ...current, ...refit, bytesPerToken: measured })
      if (refit.window !== current.window)
        logWarn('Ollama window refitted with the measured KV cost', {
          model,
          previous: current.window,
          fitted: refit.window
        })
    }
    return
  }
  // Plan once per requested window. Re-planning after a spill fit would oscillate.
  if (mode !== 'max' || request.explicit || current) return
  const budget = serverVramBudget(connection)
  if (!budget) {
    // A loopback server plans from this computer's GPUs; read them for the next load.
    if (!connection.vramGiB && isLoopbackUrl(connection.baseUrl))
      void getGpuAccelStatus().catch(() => undefined)
    return
  }
  const planned = planWindowForBudget({
    requested: maxContext,
    maxContext,
    window,
    sizeBytes: placement.sizeBytes,
    bytesPerToken,
    budgetBytes: budget.bytes,
    gpuCount: budget.gpuCount
  })
  if (!planned || planned <= window) return
  fits.set(name, { window: planned, reason: 'vram-plan', requested: base, signature })
  logWarn('Ollama window planned from VRAM', { model, requested: base, loaded: window, planned })
}

/**
 * The server refused to load at `window` for lack of memory. Records a smaller window and
 * returns it, or null when the floor was already reached.
 */
export function noteOllamaOutOfMemory(
  connection: ModelConnection,
  model: string,
  request: { requested: number; window: number; modelMaximum?: boolean }
): number | null {
  if (contextFitMode(connection) === 'off' || request.modelMaximum) return null
  const name = key(connection, model)
  const maxContext = probes.get(name)?.maxContext
  if (!maxContext) return null
  const base = windowFor(request.requested, maxContext)
  const fit = fitAfterOutOfMemory(base, request.window)
  if (!fit) return null
  fits.set(name, { ...fit, requested: base, signature: fitSignature(connection) })
  logWarn('Ollama could not load the window; using a smaller one', {
    model,
    requested: base,
    failed: request.window,
    fitted: fit.window
  })
  return fit.window
}

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
  const target = ollamaRequestWindow(connection, model, requested, {
    explicit: requestedIsExplicit(settings, model),
    modelMaximum: usesModelMaximum(settings, model)
  })
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
  apiKey: string | null,
  /** The window asked for before any fit; enables fitting when given. */
  request?: { requested: number; explicit: boolean; modelMaximum?: boolean }
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
    if (request) updateFit(connection, model, placement, request)
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
