import { config } from './config.js'
import {
  getLocalModelStatus,
  localChatCompletion,
  localChatTurn,
  releaseLocalChatSession,
  seedLocalChatSession,
  type ChatMessage
} from './local-model.js'

export type { ChatMessage }

/**
 * Cloud Agent inference runs the bundled local GGUF (Composer Full) inside the container.
 * Optional ERIS_CLOUD_LLM_BASE overrides to an external OpenAI-compatible API (ops only).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { model?: string; signal?: AbortSignal; maxTokens?: number } = {}
): Promise<string> {
  if (config.llmBase) {
    return remoteChatCompletion(messages, options)
  }
  return localChatCompletion(messages, {
    signal: options.signal,
    maxTokens: options.maxTokens
  })
}

/** Incremental turn with KV reuse (local GGUF). Falls back to full completion for remote LLM. */
export async function chatTurn(options: {
  sessionKey: string
  userMessage: string
  systemPrompt?: string
  messagesForRemote?: ChatMessage[]
  model?: string
  maxTokens?: number
  signal?: AbortSignal
}): Promise<string> {
  if (config.llmBase) {
    const messages = options.messagesForRemote || [
      ...(options.systemPrompt
        ? [{ role: 'system' as const, content: options.systemPrompt }]
        : []),
      { role: 'user' as const, content: options.userMessage }
    ]
    return remoteChatCompletion(messages, {
      model: options.model,
      signal: options.signal,
      maxTokens: options.maxTokens
    })
  }
  return localChatTurn({
    sessionKey: options.sessionKey,
    userMessage: options.userMessage,
    systemPrompt: options.systemPrompt,
    maxTokens: options.maxTokens,
    signal: options.signal
  })
}

export async function seedChatSession(
  sessionKey: string,
  messages: ChatMessage[]
): Promise<void> {
  if (config.llmBase) return
  await seedLocalChatSession(sessionKey, messages)
}

export function releaseChatSession(sessionKey: string): void {
  if (config.llmBase) return
  releaseLocalChatSession(sessionKey)
}

async function remoteChatCompletion(
  messages: ChatMessage[],
  options: { model?: string; signal?: AbortSignal; maxTokens?: number }
): Promise<string> {
  const url = `${config.llmBase}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
  if (config.llmKey) headers.Authorization = `Bearer ${config.llmKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: options.signal,
    body: JSON.stringify({
      model: options.model || config.llmModel,
      temperature: 0.2,
      max_tokens: options.maxTokens ?? 1024,
      messages
    })
  })
  const text = await res.text()
  let data: {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string } | string
  } = {}
  try {
    data = text ? (JSON.parse(text) as typeof data) : {}
  } catch {
    throw new Error(`LLM returned non-JSON (${res.status})`)
  }
  if (!res.ok) {
    const err =
      typeof data.error === 'string'
        ? data.error
        : data.error?.message || `LLM request failed (${res.status})`
    throw new Error(err)
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('LLM returned empty content')
  return content
}

export function llmReadyForJobs(): boolean {
  if (config.llmBase) return true
  const s = getLocalModelStatus().status
  return s === 'ready' || s === 'downloading' || s === 'missing'
}
