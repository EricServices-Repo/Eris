import { randomUUID } from 'crypto'
import { ollamaNativeHost } from './ollama'
import { MAX_MODEL_EVENT_BYTES, MAX_MODEL_STREAM_BYTES, ModelStreamError } from './model-sse'
import {
  modelErrorSnippet,
  type ApiStreamFailure,
  type ChatRequestMessage,
  type NativeToolCall,
  type OpenAIStreamUsage,
  type OpenAIToolDef
} from './openai-compatible'

/** Tool results name their tool here; the native API has no tool_call_id. */
function nativeMessages(messages: ChatRequestMessage[]) {
  const toolNames = new Map<string, string>()
  return messages.map((message) => {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name)
    return {
      role: message.role,
      content: message.content ?? '',
      ...(message.tool_calls?.length
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) }
            }))
          }
        : {}),
      ...(message.role === 'tool' && message.tool_call_id
        ? { tool_name: toolNames.get(message.tool_call_id) }
        : {})
    }
  })
}

type NativeChunk = {
  error?: unknown
  message?: {
    content?: unknown
    tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }>
  }
  done?: unknown
  done_reason?: unknown
  prompt_eval_count?: unknown
  eval_count?: unknown
}

const protocolError = (message: string) =>
  new ModelStreamError('MODEL_STREAM_PROTOCOL_ERROR', message)

async function* ndjsonObjects(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<NativeChunk> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let total = 0
  const parse = (line: string): NativeChunk => {
    try {
      const value: unknown = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      /* Reported below. */
    }
    throw protocolError('Malformed JSON in Ollama stream.')
  }
  for (;;) {
    signal?.throwIfAborted()
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_MODEL_STREAM_BYTES)
      throw new ModelStreamError('MODEL_STREAM_LIMIT', 'Ollama stream exceeds its size limit.')
    try {
      buffer += decoder.decode(value, { stream: true })
    } catch {
      throw protocolError('Ollama stream contains invalid UTF-8.')
    }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield parse(line)
    }
    if (buffer.length > MAX_MODEL_EVENT_BYTES)
      throw new ModelStreamError('MODEL_STREAM_LIMIT', 'Ollama event exceeds its size limit.')
  }
  if (buffer.trim()) yield parse(buffer.trim())
}

const failureOf = (error: unknown, signal?: AbortSignal): ApiStreamFailure => ({
  reason: signal?.aborted
    ? 'cancelled'
    : error instanceof ModelStreamError && error.code === 'MODEL_STREAM_LIMIT'
      ? 'output-limit'
      : error instanceof ModelStreamError && error.code === 'MODEL_STREAM_PROTOCOL_ERROR'
        ? 'protocol-error'
        : 'connection-closed',
  ...(error instanceof ModelStreamError ? { code: error.code } : {})
})

/**
 * Ollama's native chat route. `/v1/chat/completions` cannot set a context size, so
 * this is the route that makes the window Eris budgets for the one the server uses.
 */
export async function* streamOllamaChat(options: {
  baseUrl: string
  apiKey?: string | null
  model: string
  messages: ChatRequestMessage[]
  temperature: number
  numCtx: number
  keepAlive: string | number
  maxOutputTokens?: number
  signal?: AbortSignal
  refuseRedirects?: boolean
  onUsage?: (usage: OpenAIStreamUsage) => void
  onFinish?: (finishReason: string | null, complete: boolean, failure?: ApiStreamFailure) => void
  tools?: OpenAIToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  onNativeToolCalls?: (calls: NativeToolCall[]) => void
}): AsyncGenerator<string, void, unknown> {
  const response = await fetch(`${ollamaNativeHost(options.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: options.model,
      messages: nativeMessages(options.messages),
      stream: true,
      keep_alive: options.keepAlive,
      options: {
        temperature: options.temperature,
        num_ctx: options.numCtx,
        ...(options.maxOutputTokens !== undefined
          ? { num_predict: Math.max(1, Math.floor(options.maxOutputTokens)) }
          : {})
      },
      ...(options.tools?.length && options.toolChoice !== 'none' ? { tools: options.tools } : {})
    }),
    signal: options.signal,
    ...(options.refuseRedirects ? { redirect: 'error' as const } : {})
  })
  if (!response.ok || !response.body) {
    const text = await modelErrorSnippet(response, options.signal)
    throw new Error(`Model connection failed: HTTP ${response.status} ${text}`)
  }

  const reader = response.body.getReader()
  const abortReader = () => void reader.cancel(options.signal?.reason).catch(() => undefined)
  options.signal?.addEventListener('abort', abortReader, { once: true })
  if (options.signal?.aborted) abortReader()
  const calls: NativeToolCall[] = []
  let finishReason: string | null = null
  let accepted = false
  let failure: ApiStreamFailure | undefined
  try {
    let done = false
    for await (const chunk of ndjsonObjects(reader, options.signal)) {
      if (chunk.error !== undefined)
        throw protocolError(`Model provider error: ${String(chunk.error).slice(0, 500)}`)
      const text = chunk.message?.content
      if (text !== undefined && typeof text !== 'string')
        throw protocolError('Model content delta must be text.')
      if (text) yield text
      for (const call of chunk.message?.tool_calls ?? []) {
        const { name, arguments: args } = call.function ?? {}
        if (typeof name !== 'string' || !name || !args || typeof args !== 'object')
          throw protocolError('Malformed Ollama tool call.')
        calls.push({ id: `call_${randomUUID()}`, name, arguments: JSON.stringify(args) })
      }
      if (chunk.done === true) {
        done = true
        const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : 0)
        const promptTokens = count(chunk.prompt_eval_count)
        const completionTokens = count(chunk.eval_count)
        options.onUsage?.({
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        })
        finishReason = typeof chunk.done_reason === 'string' ? chunk.done_reason : 'stop'
      }
    }
    options.signal?.throwIfAborted()
    if (!done)
      throw new ModelStreamError(
        'MODEL_STREAM_INCOMPLETE',
        'Incomplete model stream ended without a finish signal.'
      )
    if (calls.length) {
      if (finishReason === 'length')
        throw new ModelStreamError(
          'MODEL_STREAM_INCOMPLETE',
          'Incomplete model tool stream; no tool actions were accepted.'
        )
      finishReason = 'tool_calls'
      options.onNativeToolCalls?.(calls)
    }
    accepted = true
  } catch (error) {
    failure = failureOf(error, options.signal)
    if (finishReason === 'length' && failure.reason === 'connection-closed')
      failure = { ...failure, reason: 'output-limit' }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortReader)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    options.onFinish?.(finishReason, accepted, failure)
  }
}
