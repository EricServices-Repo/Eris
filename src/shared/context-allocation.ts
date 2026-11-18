import { CHARS_PER_TOKEN } from './token-estimate'

export type TaskClass = 'agent' | 'chat'

export type ContextAllocation = {
  inputTokens: number
  recallTokens: number
  historyTokens: number
  /** What remains for the task, instructions, tools and current evidence. */
  freshEvidenceTokens: number
}

/** The §14.3 experiment: a starting point to tune by evaluation, not a measurement. */
export const RECALL_INPUT_SHARE = 0.15
/** Product ceiling; the actual share follows the model budget and the user limit. */
export const RECALL_MAX_TOKENS = 131_072
const RECALL_MIN_TOKENS = 128
/** Chosen so a 32K window keeps roughly the 6,000 and 24,000 characters it had. */
const HISTORY_INPUT_SHARE: Record<TaskClass, number> = { agent: 0.1, chat: 0.375 }
const HISTORY_MIN_TOKENS: Record<TaskClass, number> = { agent: 500, chat: 1_000 }
/** A floor never takes more than this of a very small window. */
const FLOOR_MAX_SHARE = 0.25

function scaled(input: number, share: number, floor: number, cap: number) {
  const reachableFloor = Math.min(floor, Math.floor(input * FLOOR_MAX_SHARE))
  return Math.min(cap, Math.max(reachableFloor, Math.floor(input * share)))
}

/**
 * The one split of a model's input window. Recall and history grow and shrink with it,
 * and everything else stays with the task and current evidence. `recallCeiling` is the
 * user's optional limit; it can only lower recall.
 */
export function allocateContext(
  inputTokens: number,
  taskClass: TaskClass,
  recallCeiling = RECALL_MAX_TOKENS
): ContextAllocation {
  const input = Math.max(0, Math.floor(inputTokens))
  const recallTokens = Math.min(
    recallCeiling,
    scaled(input, RECALL_INPUT_SHARE, RECALL_MIN_TOKENS, RECALL_MAX_TOKENS)
  )
  const historyTokens = scaled(
    input,
    HISTORY_INPUT_SHARE[taskClass],
    HISTORY_MIN_TOKENS[taskClass],
    input
  )
  return {
    inputTokens: input,
    recallTokens,
    historyTokens,
    freshEvidenceTokens: input - recallTokens - historyTokens
  }
}

export const historyChars = (allocation: ContextAllocation) =>
  allocation.historyTokens * CHARS_PER_TOKEN
