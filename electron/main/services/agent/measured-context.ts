import { CHARS_PER_TOKEN, NON_ASCII_CHARS_PER_TOKEN } from '../../../../src/shared/token-estimate'
import { isNativeGgufRef } from '../builtin-model'
import {
  compileTaskContext,
  contextCandidates,
  SYSTEM_CONTEXT_SHARE,
  type CompileTaskContextInput,
  type TokenizerFallback
} from './context-compiler'
import {
  cachedTokenCount,
  modelTokenizer,
  primeTokenCounts,
  type ModelTokenizer
} from './token-count'

const MAX_PACKS = 4
/** Aim below the limit after an overrun: a cut's density only approximates its block's. */
const OVERRUN_HEADROOM = 0.95

type Compiled = ReturnType<typeof compileTaskContext>
const ESTIMATE_RECORD = {
  method: 'characters',
  tokenizer: 'none',
  charsPerToken: CHARS_PER_TOKEN,
  nonAsciiCharsPerToken: NON_ASCII_CHARS_PER_TOKEN
} as const

function estimated(input: CompileTaskContextInput, fallback: TokenizerFallback): Compiled {
  const compiled = compileTaskContext(input)
  compiled.bundle.tokenizer = { ...ESTIMATE_RECORD, fallback }
  compiled.budget.fallback = fallback
  return compiled
}

function measured(compiled: Compiled, tokenizer: string, exactTokens: number): Compiled {
  compiled.bundle.tokenizer = { method: 'native-tokenizer', tokenizer, exactTokens }
  compiled.budget = {
    ...compiled.budget,
    method: 'native-tokenizer',
    tokenizer,
    uncertainty:
      "Exact count of this message from the loaded model's tokenizer. The chat template adds a few tokens that are not included.",
    measuredTokens: exactTokens,
    reservedForConversationTokens: compiled.budget.inputTokens - exactTokens
  }
  return compiled
}

function safeTokenizer(model: string) {
  try {
    return modelTokenizer(model)
  } catch {
    return null
  }
}

/**
 * Pack with the loaded model's real counts: count the candidates, pack, count the result,
 * and pack tighter if a cut came in over. Everything else compiles from the estimate, and
 * the bundle records which of the two happened and why.
 */
export async function compileMeasuredContext(
  input: CompileTaskContextInput,
  model: string,
  tokenizer: ModelTokenizer | null = safeTokenizer(model)
): Promise<Compiled> {
  if (!tokenizer)
    return estimated(input, isNativeGgufRef(model) ? 'model-not-loaded' : 'no-local-tokenizer')
  const tokenCount = cachedTokenCount(tokenizer.id)
  const limit = Math.floor(input.maxInputTokens * SYSTEM_CONTEXT_SHARE)
  if (!(await primeTokenCounts(tokenizer.id, contextCandidates(input), tokenizer.tokenize)))
    return estimated(input, 'tokenizer-unavailable')
  let budgetScale = 1
  for (let pack = 1; ; pack++) {
    const compiled = compileTaskContext({ ...input, tokenCount, budgetScale })
    const content = String(compiled.message.content)
    if (!(await primeTokenCounts(tokenizer.id, [content], tokenizer.tokenize)))
      return estimated(input, 'tokenizer-unavailable')
    const exactTokens = tokenCount(content)!
    if (exactTokens <= limit || pack === MAX_PACKS)
      return measured(compiled, tokenizer.id, exactTokens)
    budgetScale *= (limit / exactTokens) * OVERRUN_HEADROOM
  }
}
