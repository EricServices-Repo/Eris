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

  const weightBudget =
    budgetBytes > 0 ? Math.max(0, budgetBytes - CONTEXT_HEADROOM_BYTES) : 0

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
    gpuLayers: relaxed
      ? ('auto' as const)
      : { fitContext: { contextSize: contextMax } }
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

export function isMemoryError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  return (
    name === 'InsufficientMemoryError' ||
    /insufficient memory|out of memory|failed to allocate/i.test(message)
  )
}
