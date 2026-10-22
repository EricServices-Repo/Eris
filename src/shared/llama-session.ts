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
