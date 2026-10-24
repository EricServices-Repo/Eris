/** Helpers for incremental local GGUF chat sessions (KV reuse across agent steps). */

export type SessionChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Split a full transcript into seed history + the next user turn.
 * Preserve runtime instructions after the last user/tool-result message, too.
 * The caller must synchronize seed history on every turn, including reused sessions.
 */
export function splitSessionPrompt(messages: SessionChatMessage[]): {
  seed: SessionChatMessage[]
  userMessage: string
} | null {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return null
  if (lastUser !== messages.length - 1) {
    return {
      seed: messages.map((message) => ({ ...message })),
      userMessage:
        'Continue the active request using the latest runtime instructions and tool results above. ' +
        'Preserve completed work and address the next unfinished step.'
    }
  }
  const userMessage = messages[lastUser]!.content
  return {
    seed: messages.slice(0, lastUser),
    userMessage
  }
}

/** Convert chat messages to node-llama-cpp setChatHistory entries. */
export function messagesToLlamaHistory(
  messages: SessionChatMessage[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') out.push({ type: 'system', text: m.content })
    else if (m.role === 'user') out.push({ type: 'user', text: m.content })
    else out.push({ type: 'model', response: [m.content] })
  }
  return out
}

/**
 * A one-shot request uses the same structured history as a session turn. Nesting a
 * SYSTEM/USER/ASSISTANT transcript inside one user prompt invites the model to
 * continue that transcript, role labels and tool framing included.
 */
export function oneShotPrompt(messages: SessionChatMessage[]): {
  history: SessionChatMessage[]
  userMessage: string
} {
  const split = splitSessionPrompt(messages)
  if (split) return { history: split.seed, userMessage: split.userMessage }
  return {
    history: messages.map((message) => ({ ...message })),
    userMessage: 'Continue the active request using the latest runtime instructions above.'
  }
}

/**
 * Reply tokens that fit beside the prompt in the effective context. A fixed 16k
 * ceiling in an 8k context lets a degenerate reply run until the question deadline.
 */
export function replyTokenAllowance(input: {
  requested: number
  contextSize: number
  promptTokens: number
  reserve?: number
  minimum?: number
}): number {
  const available = input.contextSize - input.promptTokens - (input.reserve ?? 64)
  return Math.max(input.minimum ?? 256, Math.min(input.requested, available))
}

/** Map node-llama-cpp stop reasons onto transport termination reasons. */
export function nativeStopReason(
  raw: unknown
): 'eos' | 'output-limit' | 'stop-trigger' | 'tool-call' | 'cancelled' | 'unknown' {
  switch (raw) {
    case 'eogToken':
    case 'eosToken':
      return 'eos'
    case 'maxTokens':
      return 'output-limit'
    case 'stopGenerationTrigger':
    case 'customStopTrigger':
      return 'stop-trigger'
    case 'functionCalls':
      return 'tool-call'
    case 'abort':
      return 'cancelled'
    default:
      return 'unknown'
  }
}
