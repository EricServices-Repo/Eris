import { estimateContextTokens } from '../../../../src/shared/token-estimate'
import {
  adaptModelMessagesForAccounting,
  validateModelTranscript,
  modelPromptMessages,
  serializeModelMessage,
  type ModelMessage,
  type ModelCapabilities
} from '../model-protocol'
import type { ChatRequestMessage, OpenAIToolDef } from '../openai-compatible'
import {
  cachedTokenCount,
  modelTokenizer,
  primeTokenCounts,
  type ModelTokenizer
} from './token-count'

/** Native counts refer to serialized text/framing, not an exact chat-template measurement. */
export async function createPromptTokenCounter(
  model: string,
  initial: readonly ModelMessage[],
  tools: readonly OpenAIToolDef[],
  protocol: ModelCapabilities['protocol'],
  signal?: AbortSignal,
  tokenizer?: ModelTokenizer | null
) {
  signal?.throwIfAborted()
  const wire = (messages: readonly ModelMessage[]) =>
    adaptModelMessagesForAccounting(modelPromptMessages(messages, tools, protocol), protocol)
  validateModelTranscript(initial)
  const original = wire(initial)
  if (tokenizer === undefined) {
    try {
      tokenizer = modelTokenizer(model)
    } catch {
      tokenizer = null
    }
  }
  const ready =
    tokenizer &&
    (await primeTokenCounts(tokenizer.id, original.map(serializeModelMessage), tokenizer.tokenize))
  signal?.throwIfAborted()
  const lookup = ready ? cachedTokenCount(tokenizer!.id) : () => undefined
  const schemaTokens =
    protocol === 'native-tools' && tools.length ? estimateContextTokens(JSON.stringify(tools)) : 0
  const countWire = (messages: readonly ChatRequestMessage[]) =>
    messages.reduce((sum, message) => {
      const serialized = serializeModelMessage(message)
      // Counting framing separately is conservative; actual native template checks remain mandatory.
      return sum + (lookup(serialized) ?? estimateContextTokens(serialized)) + 8
    }, 0)
  return {
    countWire,
    count: (messages: readonly ModelMessage[]) => countWire(wire(messages)) + schemaTokens,
    method: ready
      ? ('native-tokenizer-with-estimated-edits' as const)
      : ('serialized-character-estimate' as const),
    tokenizer: ready ? tokenizer!.id : undefined
  }
}
