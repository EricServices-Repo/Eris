import { createHash } from 'crypto'
import { residentTokenizerId, tokenizeWithLoadedModel } from '../builtin-model'
import { nativeEntry } from '../model-capabilities'
import { loadedModelFacts } from '../model-runtime'

/** Bump when what a count means changes. Counts live in memory, so a runtime upgrade clears them. */
const TOKEN_COUNT_VERSION = 1
const MAX_CACHED_COUNTS = 8_192
/** One worker message per batch, so a large prompt cannot hold the worker's event loop. */
const MAX_BATCH_CHARS = 64 * 1024
/** A send never waits longer than this for counts; it uses the estimate and says so. */
export const TOKEN_COUNT_DEADLINE_MS = 250

export type TokenCountLookup = (text: string) => number | undefined
export type Tokenize = (texts: string[], signal: AbortSignal) => Promise<number[] | null>

// Digests and numbers only: this cache keeps no prompt text.
const counts = new Map<string, number>()
export const clearTokenCounts = () => counts.clear()

const keyOf = (tokenizer: string, text: string) =>
  `${TOKEN_COUNT_VERSION}:${tokenizer}:${createHash('sha256').update(text).digest('hex')}`

/** A synchronous view of the cache for one tokenizer, which is what the compiler reads. */
export const cachedTokenCount =
  (tokenizer: string): TokenCountLookup =>
  (text) => {
    const key = keyOf(tokenizer, text)
    const count = counts.get(key)
    if (count === undefined) return undefined
    counts.delete(key)
    counts.set(key, count)
    return count
  }

function batches(texts: readonly string[]) {
  const result: string[][] = []
  let chars = Infinity
  for (const text of texts) {
    if (chars + text.length > MAX_BATCH_CHARS) {
      result.push([])
      chars = 0
    }
    result.at(-1)!.push(text)
    chars += text.length
  }
  return result
}

/** Fill the cache for `texts`. False means the counts are not all available. */
export async function primeTokenCounts(
  tokenizer: string,
  texts: readonly string[],
  tokenize: Tokenize,
  deadlineMs = TOKEN_COUNT_DEADLINE_MS
): Promise<boolean> {
  const lookup = cachedTokenCount(tokenizer)
  const missing = [...new Set(texts)].filter((text) => lookup(text) === undefined)
  if (!missing.length) return true
  const controller = new AbortController()
  const expired = new Promise<null>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, deadlineMs)
    controller.signal.addEventListener('abort', () => clearTimeout(timer))
  })
  try {
    for (const batch of batches(missing)) {
      const result = await Promise.race([tokenize(batch, controller.signal), expired])
      if (!result || result.length !== batch.length) return false
      batch.forEach((text, index) => counts.set(keyOf(tokenizer, text), result[index]!))
    }
    while (counts.size > MAX_CACHED_COUNTS) counts.delete(counts.keys().next().value!)
    return true
  } catch {
    return false
  } finally {
    controller.abort()
  }
}

export type ModelTokenizer = { id: string; tokenize: Tokenize }

/** The tokenizer of the model resident now. A compile never loads a model to count with it. */
export function modelTokenizer(model: string): ModelTokenizer | null {
  const entry = nativeEntry(model)
  const id = entry && loadedModelFacts(entry.ref) ? residentTokenizerId(entry.ref) : null
  return id ? { id, tokenize: (texts, signal) => tokenizeWithLoadedModel(texts, signal) } : null
}
