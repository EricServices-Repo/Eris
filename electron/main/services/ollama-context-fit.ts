/**
 * Fitting an Ollama context window (`num_ctx`) to the memory the server has (#677).
 *
 * Ollama gives no free-VRAM API, so the fit is driven by what `/api/ps` reports after a
 * request (`size` and `size_vram`) plus an estimate of the KV cache cost per token read
 * from `/api/show`. Everything here is pure; ollama-runtime.ts owns the state.
 */

import { MIN_CONTEXT_TOKENS } from '../../../src/shared/model-context'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

/** Windows are rounded down to this, so a fit never asks for an odd size. */
export const FIT_STEP_TOKENS = 1024
/** Lowest context supported by Eris; cache-heavy models may need less than 8K. */
export const MIN_FIT_WINDOW = MIN_CONTEXT_TOKENS
/** Slack added to a measured spill so the next load is not right at the edge. */
export const SPILL_HEADROOM_BYTES = 256 * MIB
/** Per-GPU allowance (CUDA context, compute graph) when planning from a VRAM total. */
export const PER_GPU_RESERVE_BYTES = 512 * MIB
/** Share of a VRAM total held back when planning a larger window. */
export const PLAN_RESERVE_SHARE = 0.05
/** Above this a per-token cost is a measurement error, not a KV cache. */
const MAX_PLAUSIBLE_BYTES_PER_TOKEN = 8 * MIB

export type KvCacheType = 'f16' | 'q8_0' | 'q4_0'

/** Bytes per cached element: ggml block sizes (q8_0: 34 bytes per 32, q4_0: 18 per 32). */
export const KV_ELEMENT_BYTES: Record<KvCacheType, number> = {
  f16: 2,
  q8_0: 34 / 32,
  q4_0: 18 / 32
}

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null

function archField(info: Record<string, unknown>, arch: string, name: string): unknown {
  const exact = info[`${arch}.${name}`]
  if (exact !== undefined) return exact
  return Object.entries(info).find(([key]) => key.endsWith(`.${name}`))?.[1]
}

/**
 * KV cache bytes per token from `/api/show` `model_info`, or null when the fields are
 * missing. It is high for sliding-window and compressed (MLA) caches and low for a server
 * with several parallel slots. A measured cost replaces it once two loads at different
 * windows are seen, and ollama-runtime then recomputes the fit from the load that spilled.
 */
export function estimateKvBytesPerToken(
  modelInfo: unknown,
  cacheType: KvCacheType = 'f16'
): number | null {
  if (!modelInfo || typeof modelInfo !== 'object') return null
  const info = modelInfo as Record<string, unknown>
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : ''
  const blocks = positiveInt(archField(info, arch, 'block_count'))
  if (!blocks) return null
  const heads = positiveInt(archField(info, arch, 'attention.head_count'))
  const embedding = positiveInt(archField(info, arch, 'embedding_length'))
  const fallbackDim = heads && embedding ? Math.floor(embedding / heads) : null
  const keyDim = positiveInt(archField(info, arch, 'attention.key_length')) ?? fallbackDim
  const valueDim = positiveInt(archField(info, arch, 'attention.value_length')) ?? keyDim
  if (!keyDim || !valueDim) return null

  // Sum of KV heads over the layers that keep a per-token cache.
  const kvHeads = archField(info, arch, 'attention.head_count_kv')
  let kvHeadLayers: number
  if (Array.isArray(kvHeads)) {
    // Per-layer list: 0 marks a recurrent or linear-attention layer with a fixed state.
    kvHeadLayers = kvHeads
      .slice(0, blocks)
      .reduce<number>((sum, value) => sum + (positiveInt(value) ?? 0), 0)
  } else {
    const perLayer = positiveInt(kvHeads) ?? heads
    if (!perLayer) return null
    // Hybrid models (for example qwen3next) use full attention on every Nth layer only.
    const interval = positiveInt(archField(info, arch, 'full_attention_interval'))
    const attentionLayers = interval && interval > 1 ? Math.ceil(blocks / interval) : blocks
    kvHeadLayers = perLayer * attentionLayers
  }
  if (kvHeadLayers <= 0) return null
  return Math.ceil(kvHeadLayers * (keyDim + valueDim) * KV_ELEMENT_BYTES[cacheType])
}

/** The per-token cost from two loads at different windows, or null when they disagree. */
export function learnedKvBytesPerToken(
  a: { window: number; sizeBytes: number },
  b: { window: number; sizeBytes: number }
): number | null {
  const tokens = b.window - a.window
  if (!tokens) return null
  const bytes = (b.sizeBytes - a.sizeBytes) / tokens
  return bytes > 0 && bytes <= MAX_PLAUSIBLE_BYTES_PER_TOKEN ? Math.ceil(bytes) : null
}

export const roundDownToStep = (tokens: number) =>
  Math.max(MIN_FIT_WINDOW, Math.floor(tokens / FIT_STEP_TOKENS) * FIT_STEP_TOKENS)

/** The smallest window a fit may choose for this request. */
export const fitFloor = (requested: number) => Math.min(requested, MIN_FIT_WINDOW)

export type FitReason = 'spill' | 'out-of-memory' | 'vram-plan'

export type WindowFit = {
  /** The window to send instead of the requested one. */
  window: number
  reason: FitReason
  /** An observed load still spills at the lowest supported context. */
  minimumWindowSpills?: boolean
}

/**
 * After a load at `window` placed `vramBytes` of `sizeBytes` on the GPU: the largest
 * window that would have stayed in VRAM. Null when nothing spilled.
 */
export function fitAfterSpill(input: {
  requested: number
  window: number
  sizeBytes: number
  vramBytes: number
  bytesPerToken: number | null
}): WindowFit | null {
  const spill = input.sizeBytes - input.vramBytes
  if (!(spill > 0)) return null
  const floor = fitFloor(input.requested)
  if (input.window <= floor) return { window: floor, reason: 'spill', minimumWindowSpills: true }
  if (!input.bytesPerToken) {
    const halved = Math.max(floor, roundDownToStep(input.window / 2))
    return { window: Math.max(floor, Math.min(halved, input.window - FIT_STEP_TOKENS)), reason: 'spill' }
  }
  const cut = Math.ceil((spill + SPILL_HEADROOM_BYTES) / input.bytesPerToken)
  const target = input.window - cut
  if (target < floor) return { window: floor, reason: 'spill' }
  return {
    window: Math.max(floor, Math.min(roundDownToStep(target), input.window - FIT_STEP_TOKENS)),
    reason: 'spill'
  }
}

/** After the server refused to load at `window`: try half, never below the floor. */
export function fitAfterOutOfMemory(requested: number, window: number): WindowFit | null {
  const floor = fitFloor(requested)
  if (window <= floor) return null
  return { window: Math.max(floor, roundDownToStep(window / 2)), reason: 'out-of-memory' }
}

/**
 * The largest window a VRAM budget holds, given one fully placed load. `sizeBytes` at
 * `window` includes the weights, the KV cache for that window and the compute graph.
 * Null when the measurement cannot support a plan.
 */
export function planWindowForBudget(input: {
  requested: number
  maxContext: number
  window: number
  sizeBytes: number
  bytesPerToken: number | null
  budgetBytes: number
  gpuCount: number
}): number | null {
  if (!input.bytesPerToken || !(input.budgetBytes > 0) || !(input.sizeBytes > 0)) return null
  const fixed = input.sizeBytes - input.bytesPerToken * input.window
  if (fixed <= 0) return null
  const usable =
    input.budgetBytes * (1 - PLAN_RESERVE_SHARE) -
    PER_GPU_RESERVE_BYTES * Math.max(1, input.gpuCount) -
    fixed
  if (usable <= 0) return null
  const affordable = usable / input.bytesPerToken
  if (affordable < fitFloor(input.requested)) return null
  const tokens = roundDownToStep(affordable)
  const capped = Math.min(tokens, input.maxContext, input.requested)
  return capped >= fitFloor(input.requested) ? capped : null
}

/** Matches the ways Ollama and llama.cpp report a failed allocation. */
export function isOutOfMemoryError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return /requires more (system )?memory|out of memory|cudaMalloc failed|insufficient memory|failed to allocate|unable to allocate/i.test(
    text
  )
}

export const gibToBytes = (gib: number) => Math.round(gib * GIB)
