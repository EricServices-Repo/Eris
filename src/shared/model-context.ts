/** Product validation ceiling, not a claim about any model's supported window. */
export const MAX_CONTEXT_TOKENS = 2_097_152
export const DEFAULT_CONTEXT_TOKENS = 32_768
export const MIN_CONTEXT_TOKENS = 512

export function validContextWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_TOKENS &&
    value <= MAX_CONTEXT_TOKENS
  )
}

export function boundedContextWindow(requested: number, supported = MAX_CONTEXT_TOKENS): number {
  return Math.min(
    MAX_CONTEXT_TOKENS,
    validContextWindow(supported) ? supported : DEFAULT_CONTEXT_TOKENS,
    validContextWindow(requested) ? requested : DEFAULT_CONTEXT_TOKENS
  )
}

/** Explicit reply and framing reserves leave most of a large window usable. */
export function modelInputBudget(context: number, outputReserve: number): number {
  const safety = Math.max(128, Math.min(2048, Math.ceil(context * 0.02)))
  return Math.max(1, context - outputReserve - safety)
}
