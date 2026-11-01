/**
 * Fit local GGUFs to the VRAM Eris can actually use.
 * Shared-GPU free memory wins; otherwise the best GPU's free memory;
 * otherwise its total minus a reserve so the OS and the app keep room.
 */

export const OS_RESERVE_BYTES = 2 * 1024 ** 3
/** Leave this much of the budget for KV cache after the weight file. */
export const CONTEXT_HEADROOM_BYTES = Math.round(1.5 * 1024 ** 3)

/** Highest quality first. A file is chosen only when it fits the weight budget. */
export const QUANT_QUALITY = [
  'Q8_0',
  'Q6_K',
  'Q5_K_M',
  'Q5_K_S',
  'Q5_0',
  'Q4_K_M',
  'Q4_K_S',
  'IQ4_XS',
  'Q4_0',
  'Q3_K_M'
] as const

/** Desktop default when VRAM is unknown: Q4_K_M, then nearby quants. */
const QUANT_WHEN_UNKNOWN = [
  'Q4_K_M',
  'Q4_K_S',
  'Q5_K_M',
  'Q4_0',
  'IQ4_XS',
  'Q5_0',
  'Q3_K_M',
  'Q6_K',
  'Q8_0'
] as const

export type VramBudgetInput = {
  vramShareFreeBytes?: number
  vramShareTotalBytes?: number
  preferredFreeBytes?: number
  preferredTotalBytes?: number
}

/** A generation on a loaded model allocates scratch, not another copy of the model. */
export const GENERATION_SCRATCH_BYTES = 256 * 1024 ** 2
/** CPU-side cost of a model whose weights and KV cache live on a dedicated GPU. */
export const DEDICATED_HOST_OVERHEAD_BYTES = 1024 ** 3

/** Peak memory a text model can reach, wherever it ends up. */
export const textModelPeakBytes = (approxBytes: number) => Math.ceil(approxBytes * 1.25 + 1024 ** 3)

/**
 * Host memory one text lease charges. A dedicated GPU holding the whole peak keeps it
 * off the host, and a loaded model is already reflected in measured free memory. Until
 * load reports its actual offload, a model that may spill is charged in full.
 */
export function textHostReservation(options: {
  peakBytes: number
  deviceBytes: number
  loaded: boolean
}): { requestedBytes: number; residentBytes: number } {
  const offloaded = options.deviceBytes >= options.peakBytes
  const requestedBytes = offloaded ? DEDICATED_HOST_OVERHEAD_BYTES : options.peakBytes
  return {
    requestedBytes,
    residentBytes: options.loaded ? Math.max(0, requestedBytes - GENERATION_SCRATCH_BYTES) : 0
  }
}

export function inferenceBudgetBytes(input: VramBudgetInput): number {
  const sharedFree = input.vramShareFreeBytes ?? 0
  if (sharedFree > 0) return sharedFree
  const sharedTotal = input.vramShareTotalBytes ?? 0
  if (sharedTotal > 0) return Math.max(0, sharedTotal - OS_RESERVE_BYTES)
  const free = input.preferredFreeBytes ?? 0
  if (free > 0) return free
  const total = input.preferredTotalBytes ?? 0
  if (total > 0) return Math.max(0, total - OS_RESERVE_BYTES)
  return 0
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Context range passed to node-llama-cpp so it can grow up to what VRAM allows.
 * Composer Lite loads 32k. Larger local and full models may use up to 64k,
 * still bounded by the model card and the settings window.
 */
export const LITE_CONTEXT_MAX = 32_768
/** Max tokens a built-in model may write in one reply. */
export const REPLY_MAX_TOKENS = 16_384

const LOCAL_CONTEXT_8K = 8_192
const LOCAL_CONTEXT_16K = 16_384
const LOCAL_CONTEXT_16K_HEADROOM_BYTES = Math.round(3.5 * 1024 ** 3)
const LOCAL_CONTEXT_32K_HEADROOM_BYTES = 7 * 1024 ** 3

/**
 * Keep large local models on the GPU by avoiding a context allocation that
 * consumes the VRAM needed for their remaining layers. A 14B Q4 model is
 * roughly 9 GB, so 32K context is usually counterproductive on 8 GB-class
 * multi-GPU systems even when the combined capacity can hold the weights.
 */
export function localPerformanceContextMax(options: {
  requested: number
  modelBytes?: number
  vramBudgetBytes?: number
}): number {
  const requested = clamp(options.requested, 512, 65_536)
  const modelBytes = Math.max(0, options.modelBytes ?? 0)
  const budgetBytes = Math.max(0, options.vramBudgetBytes ?? 0)

  if (modelBytes <= 0) return requested

  if (budgetBytes > 0) {
    const headroom = budgetBytes - modelBytes
    if (headroom < LOCAL_CONTEXT_16K_HEADROOM_BYTES) {
      return Math.min(requested, LOCAL_CONTEXT_8K)
    }
    if (headroom < LOCAL_CONTEXT_32K_HEADROOM_BYTES) {
      return Math.min(requested, LOCAL_CONTEXT_16K)
    }
    return requested
  }

  // GPU memory reporting can be unavailable on some drivers. Use the model
  // size as a safe fallback instead of reserving 32K for every Hub download.
  if (modelBytes >= 8 * 1024 ** 3) return Math.min(requested, LOCAL_CONTEXT_8K)
  if (modelBytes >= 5 * 1024 ** 3) return Math.min(requested, LOCAL_CONTEXT_16K)
  return requested
}

export function contextLimits(options: {
  tier?: string
  role?: string
  modelContext?: number
  settingsContext?: number
}): { min: number; max: number } {
  const builtinLite = options.tier === 'lite' && options.role !== 'local'
  const settings = clamp(options.settingsContext || 32768, 512, 131072)
  const model = clamp(options.modelContext || settings, 512, 131072)
  const cap = Math.min(settings, model, builtinLite ? LITE_CONTEXT_MAX : 65536)
  const min = Math.min(builtinLite ? 4096 : 8192, cap)
  return { min, max: Math.max(min, cap) }
}

export function quantOfFilename(path: string): string {
  const base = path.split('/').pop() || path
  const upper = base.toUpperCase()
  for (const quant of QUANT_QUALITY) {
    if (upper.includes(quant)) return quant
  }
  for (const quant of QUANT_WHEN_UNKNOWN) {
    if (upper.includes(quant)) return quant
  }
  const match = base.match(/[-_](Q\d[_A-Z0-9]+|IQ\d[_A-Z0-9]+)\.gguf$/i)
  return match ? match[1].toUpperCase() : ''
}

function isWeightFile(path: string): boolean {
  const base = path.split('/').pop() || path
  if (!/\.gguf$/i.test(base)) return false
  if (/mmproj|encoder|vision|embed|fp16/i.test(base)) return false
  return true
}

function unknownQuantScore(path: string): number {
  const quant = quantOfFilename(path)
  const idx = QUANT_WHEN_UNKNOWN.indexOf(quant as (typeof QUANT_WHEN_UNKNOWN)[number])
  if (idx >= 0) return 1000 - idx
  if (/Q4|IQ4/i.test(path)) return 100
  if (/Q5/i.test(path)) return 80
  if (/Q3/i.test(path)) return 60
  if (/Q6|Q8/i.test(path)) return 40
  return 10
}

export function pickGgufForBudget<T extends { path: string; sizeBytes: number }>(
  files: T[],
  budgetBytes: number
): { file: T; fits: boolean } | null {
  const candidates = files.filter((file) => isWeightFile(file.path))
  if (!candidates.length) return null

  const weightBudget = budgetBytes > 0 ? Math.max(0, budgetBytes - CONTEXT_HEADROOM_BYTES) : 0

  if (weightBudget > 0) {
    for (const quant of QUANT_QUALITY) {
      const matches = candidates
        .filter(
          (file) =>
            quantOfFilename(file.path) === quant &&
            file.sizeBytes > 0 &&
            file.sizeBytes <= weightBudget
        )
        .sort((a, b) => a.sizeBytes - b.sizeBytes)
      if (matches.length) return { file: matches[0]!, fits: true }
    }
  }

  const ranked = [...candidates].sort(
    (a, b) => unknownQuantScore(b.path) - unknownQuantScore(a.path)
  )
  const file = ranked[0]!
  const fits = weightBudget > 0 && file.sizeBytes > 0 && file.sizeBytes <= weightBudget
  return { file, fits }
}

export function modelLoadOptions(modelPath: string, contextMax: number, relaxed: boolean) {
  return {
    modelPath,
    useMmap: 'auto' as const,
    defaultContextFlashAttention: true as const,
    gpuLayers: relaxed ? ('auto' as const) : { fitContext: { contextSize: contextMax } }
  }
}

/** Every layer on the GPU, or an error. `fitContext` would drop layers to keep the window. */
export const fullOffloadOptions = (modelPath: string) => ({
  modelPath,
  useMmap: 'auto' as const,
  defaultContextFlashAttention: true as const,
  gpuLayers: 'max' as const
})

/** The last resort when spilling: no layers, so no VRAM for a context to compete with. */
export const cpuOnlyOptions = (modelPath: string) => ({
  ...fullOffloadOptions(modelPath),
  gpuLayers: 0 as const
})

/** Below this, tool schemas and the task leave too little of the window to work in. */
export const PLACEMENT_MIN_WINDOW = 4_096

export type PlacementStep = {
  stage: 'all-layers' | 'context' | 'cpu-spill'
  /** The largest window this step asked for. */
  window: number
  outcome: 'placed' | 'did-not-fit'
  reason?: string
}
export type ModelPlacement = {
  /** Layers may be on the CPU, because no window between the target and the floor fit. */
  allowedSpill: boolean
  steps: PlacementStep[]
}

export class CpuSpillRefusedError extends Error {
  constructor(public steps: PlacementStep[]) {
    super(
      `This model does not fit on the GPU, even with a ${PLACEMENT_MIN_WINDOW}-token context. ` +
        'Choose a smaller model, or turn on "Allow CPU layers" in Settings → Models.'
    )
    this.name = 'CpuSpillRefusedError'
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type ModelLoad =
  | ReturnType<typeof modelLoadOptions>
  | ReturnType<typeof fullOffloadOptions>
  | ReturnType<typeof cpuOnlyOptions>

/**
 * A smaller window with RAM paging beats a larger window with CPU layers. Every layer goes
 * on the GPU first, then the runtime sizes the largest window that fits above a floor,
 * from its own estimates. Only when that fails may layers stay on the CPU, and each step
 * is reported, so a spill always says what was tried first. No GPU means nothing to place.
 */
export async function placeModel<M, C>(input: {
  load: (options: ModelLoad) => Promise<M>
  createContext: (model: M, options: ReturnType<typeof contextCreateOptions>) => Promise<C>
  disposeModel: (model: M) => Promise<void> | void
  modelPath: string
  plan: { min: number; target: number }
  gpu: boolean
  allowCpuSpill: boolean
}): Promise<{ model: M; context: C; placement: ModelPlacement }> {
  const { load, createContext, disposeModel, modelPath, plan, gpu, allowCpuSpill } = input
  const { target } = plan
  const steps: PlacementStep[] = []
  /** A context failure must not leave model weights occupying VRAM. */
  const withContext = async (model: M, span: { min: number; max: number }, floor?: number) => {
    try {
      return await createContextWithVramFallback(
        (options) => createContext(model, options),
        span,
        floor
      )
    } catch (error) {
      await disposeModel(model)
      throw error
    }
  }
  if (gpu) {
    let model: M | undefined
    try {
      model = await load(fullOffloadOptions(modelPath))
    } catch (error) {
      if (!isMemoryError(error)) throw error
      steps.push({
        stage: 'all-layers',
        window: target,
        outcome: 'did-not-fit',
        reason: reasonOf(error)
      })
    }
    if (model !== undefined) {
      const floor = Math.min(PLACEMENT_MIN_WINDOW, target)
      try {
        const context = await withContext(model, { min: floor, max: target }, floor)
        steps.push({ stage: 'context', window: target, outcome: 'placed' })
        return { model, context, placement: { allowedSpill: false, steps } }
      } catch (error) {
        if (!isMemoryError(error)) throw error
        steps.push({
          stage: 'context',
          window: target,
          outcome: 'did-not-fit',
          reason: reasonOf(error)
        })
      }
    }
    if (!allowCpuSpill) throw new CpuSpillRefusedError(steps)
  }
  if (!gpu) {
    const model = await load(modelLoadOptions(modelPath, target, false))
    const context = await withContext(model, { min: Math.min(plan.min, target), max: target })
    return { model, context, placement: { allowedSpill: false, steps } }
  }
  // Reserve the floor window first, which keeps the most layers. Reserving the whole target
  // keeps fewer. If layers still leave no room for a context, CPU only needs no VRAM at all.
  const rungs = [
    ...[...new Set([Math.min(PLACEMENT_MIN_WINDOW, target), target])].map((window) => ({
      window,
      options: modelLoadOptions(modelPath, window, false) as ModelLoad
    })),
    { window: target, options: cpuOnlyOptions(modelPath) }
  ]
  for (const [index, { window, options }] of rungs.entries()) {
    try {
      const model = await load(options)
      const context = await withContext(model, { min: Math.min(plan.min, window), max: target })
      steps.push({ stage: 'cpu-spill', window, outcome: 'placed' })
      return { model, context, placement: { allowedSpill: true, steps } }
    } catch (error) {
      if (!isMemoryError(error) || index === rungs.length - 1) throw error
      steps.push({ stage: 'cpu-spill', window, outcome: 'did-not-fit', reason: reasonOf(error) })
    }
  }
  throw new CpuSpillRefusedError(steps)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimatedKvBytes(model: any, context: any): number | undefined {
  try {
    const { gpuVram, cpuRam } = model.fileInsights.estimateContextResourceRequirements({
      contextSize: context.contextSize,
      modelGpuLayers: model.gpuLayers,
      flashAttention: true
    })
    return gpuVram + cpuRam
  } catch {
    return undefined
  }
}

/** The allocation a loaded model and context report; budgets follow this, not the plan. */
export function allocationFacts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any
): {
  contextSize?: number
  trainContextSize?: number
  gpuLayers?: number
  totalLayers?: number
  kvBytes?: number
} {
  return {
    contextSize: context?.contextSize,
    trainContextSize: model?.trainContextSize,
    gpuLayers: model?.gpuLayers,
    totalLayers: model?.fileInsights?.totalLayers,
    kvBytes: estimatedKvBytes(model, context)
  }
}

export function contextCreateOptions(
  min: number,
  max: number,
  quantizedKv: boolean
): {
  sequences: number
  flashAttention: true
  contextSize: { min: number; max: number }
  experimentalKvCacheKeyType?: 'Q8_0'
  experimentalKvCacheValueType?: 'Q8_0'
} {
  const span = { min, max: Math.max(min, max) }
  return {
    sequences: 1,
    flashAttention: true,
    contextSize: span,
    ...(quantizedKv
      ? {
          experimentalKvCacheKeyType: 'Q8_0' as const,
          experimentalKvCacheValueType: 'Q8_0' as const
        }
      : {})
  }
}

/**
 * The requested minimum is a quality target, not a requirement to fail the chat.
 * The native allocator already searches min..max. If that entire range fails,
 * halve the minimum and retry a fixed smaller window, down to 512 tokens.
 * A default-cache retry is useful for unsupported quantization, but on OOM it
 * only consumes more memory, so shrink while keeping quantized KV instead.
 */
export async function createContextWithVramFallback<T>(
  create: (options: ReturnType<typeof contextCreateOptions>) => Promise<T>,
  plan: { min: number; max: number },
  floor = 512
): Promise<T> {
  let min = Math.max(floor, Math.floor(plan.min))
  let max = Math.max(min, Math.floor(plan.max))
  for (;;) {
    try {
      return await create(contextCreateOptions(min, max, true))
    } catch (quantizedError) {
      if (!isMemoryError(quantizedError)) {
        // Some backends lack quantized KV support. Do not retry unrelated
        // default-cache failures at every possible size.
        try {
          return await create(contextCreateOptions(min, max, false))
        } catch (defaultError) {
          if (!isMemoryError(defaultError) || min === floor) throw defaultError
        }
      } else if (min === floor) {
        throw quantizedError
      }
      min = Math.max(floor, Math.floor(min / 2))
      max = min
    }
  }
}

export function isMemoryError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  return (
    name === 'InsufficientMemoryError' ||
    /insufficient memory|out of memory|failed to allocate|too large for (?:the )?available (?:vram|ram|memory|resources)|not enough (?:vram|ram|memory)/i.test(
      message
    )
  )
}
