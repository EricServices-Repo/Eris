import { config } from './config.js'
import { getLocalModelStatus, localChatCompletion } from './local-model.js'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Cloud Agent inference runs the bundled local GGUF (Composer Lite) inside the container.
 * Optional ERIS_CLOUD_LLM_BASE overrides to an external OpenAI-compatible API (ops only).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { model?: string; signal?: AbortSignal } = {}
): Promise<string> {
  if (config.llmBase) {
    return remoteChatCompletion(messages, options)
  }
  return localChatCompletion(messages, { signal: options.signal })
}

async function remoteChatCompletion(
  messages: ChatMessage[],
  options: { model?: string; signal?: AbortSignal }
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
