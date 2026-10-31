import { randomUUID } from 'crypto'
import { modelSseEvents, ModelStreamError, MAX_MODEL_EVENT_BYTES } from './model-sse'
export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type OpenAIStreamUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type NativeToolCall = {
  id: string
  name: string
  arguments: string
}

export interface ApiStreamFailure {
  reason: 'protocol-error' | 'output-limit' | 'cancelled' | 'connection-closed' | 'content-filter'
  code?: string
}

export type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export async function modelErrorSnippet(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', abort, { once: true })
  let text = '',
    bytes = 0
  const decoder = new TextDecoder()
  try {
    while (bytes < 4096) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) break
      const take = chunk.value.subarray(0, 4096 - bytes)
      bytes += take.byteLength
      text += decoder.decode(take, { stream: true })
    }
    return (text + decoder.decode()).slice(0, 1000)
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function* streamOpenAICompatible(options: {
  baseUrl: string
  apiKey?: string | null
  model: string
  messages: ChatRequestMessage[]
  temperature: number
  maxOutputTokens?: number
  signal?: AbortSignal
  /** A destination cleared for recall must not hand the request to another host. */
  refuseRedirects?: boolean
  onUsage?: (usage: OpenAIStreamUsage) => void
  /** The stream's finish_reason (if any) and whether it ended with a finish signal or [DONE]. */
  onFinish?: (finishReason: string | null, complete: boolean, failure?: ApiStreamFailure) => void
  tools?: OpenAIToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  /** Filled when the stream ends with native function tool calls. */
  onNativeToolCalls?: (calls: NativeToolCall[]) => void
}): AsyncGenerator<string, void, unknown> {
  const root = options.baseUrl.replace(/\/$/, '')
  const url = root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  // include_usage is OpenAI-style; many local servers (Ollama/LM Studio) reject unknown fields.
  const supportsUsageHint =
    /openai\.com|openrouter\.ai|together\.xyz|groq\.com|deepseek\.com/i.test(root)
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature,
    stream: true
  }
  if (options.maxOutputTokens !== undefined)
    body.max_tokens = Math.max(1, Math.floor(options.maxOutputTokens))
  if (supportsUsageHint) body.stream_options = { include_usage: true }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice || 'auto'
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
    ...(options.refuseRedirects ? { redirect: 'error' as const } : {})
  })

  if (!res.ok || !res.body) {
    const text = await modelErrorSnippet(res, options.signal)
    throw new Error(`Model connection failed: HTTP ${res.status} ${text}`)
  }

  const reader = res.body.getReader()
  let complete = false
  let accepted = false
  let failure: ApiStreamFailure | undefined
  let finishReason: string | null = null
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()
  const protocolError = (message: string) =>
    new ModelStreamError('MODEL_STREAM_PROTOCOL_ERROR', message)
  const abortReader = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', abortReader, { once: true })
  if (options.signal?.aborted) abortReader()
  try {
    for await (const data of modelSseEvents(reader, options.signal)) {
      if (data.trim() === '[DONE]') {
        complete = true
        break
      }
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        throw protocolError('Malformed JSON in model SSE data event.')
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw protocolError('Model SSE payload must be an object.')
      const json = payload as {
        error?: { message?: string }
        choices?: Array<{
          delta?: {
            content?: string | null
            tool_calls?: Array<{
              index?: number
              id?: string
              type?: string
              function?: { name?: string; arguments?: string }
            }>
          }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      if (json.error)
        throw protocolError(
          `Model provider error: ${String(json.error.message ?? 'unknown error').slice(0, 500)}`
        )
      if (json.choices !== undefined && !Array.isArray(json.choices))
        throw protocolError('Model choices must be an array.')
      if (json.usage && options.onUsage) {
        const tokens = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
        const promptTokens = tokens(json.usage.prompt_tokens)
        const completionTokens = tokens(json.usage.completion_tokens)
        options.onUsage({
          promptTokens,
          completionTokens,
          totalTokens: tokens(json.usage.total_tokens) || promptTokens + completionTokens
        })
      }
      const choice = json.choices?.[0]
      if (!choice) continue // Usage-only frames are valid.
      if (typeof choice !== 'object' || Array.isArray(choice))
        throw protocolError('Model choice must be an object.')
      if (
        choice.delta !== undefined &&
        (!choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta))
      )
        throw protocolError('Model delta must be an object.')
      if (choice.finish_reason) {
        if (typeof choice.finish_reason !== 'string')
          throw protocolError('Invalid model finish reason.')
        finishReason = choice.finish_reason
        complete = true
      }
      const chunk = choice.delta?.content
      if (chunk !== null && chunk !== undefined && typeof chunk !== 'string')
        throw protocolError('Model content delta must be text.')
      if (chunk) yield chunk
      const deltas = choice.delta?.tool_calls
      if (deltas !== undefined && !Array.isArray(deltas))
        throw protocolError('Model tool deltas must be an array.')
      for (const tc of deltas ?? []) {
        if (!tc || typeof tc !== 'object' || Array.isArray(tc))
          throw protocolError('Model tool delta must be an object.')
        const index = tc.index ?? 0
        if (!Number.isSafeInteger(index) || index < 0 || index >= 128)
          throw protocolError('Invalid or excessive model tool-call index.')
        const prev = toolAcc.get(index) ?? { id: '', name: '', arguments: '' }
        if (tc.id !== undefined) {
          if (typeof tc.id !== 'string' || tc.id.length > 512)
            throw protocolError('Invalid model tool-call ID.')
          prev.id = tc.id
        }
        if (tc.function?.name !== undefined) {
          if (typeof tc.function.name !== 'string') throw protocolError('Invalid model tool name.')
          prev.name += tc.function.name
          if (prev.name.length > 256) throw protocolError('Model tool name exceeds its size limit.')
        }
        if (tc.function?.arguments !== undefined) {
          if (typeof tc.function.arguments !== 'string')
            throw protocolError('Model tool arguments must be text.')
          prev.arguments += tc.function.arguments
          if (Buffer.byteLength(prev.arguments) > MAX_MODEL_EVENT_BYTES)
            throw new ModelStreamError(
              'MODEL_STREAM_LIMIT',
              'Model tool arguments exceed their size limit.'
            )
        }
        toolAcc.set(index, prev)
      }
    }
    options.signal?.throwIfAborted()
    if (!complete)
      throw new ModelStreamError(
        'MODEL_STREAM_INCOMPLETE',
        'Incomplete model stream ended without a finish signal.'
      )
    if (toolAcc.size) {
      if (finishReason === 'length' || finishReason === 'content_filter')
        throw new ModelStreamError(
          'MODEL_STREAM_INCOMPLETE',
          'Incomplete model tool stream; no tool actions were accepted.'
        )
      const calls: NativeToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => {
          if (!value.name) throw protocolError('Model tool call has no function name.')
          let args: unknown
          try {
            args = JSON.parse(value.arguments || '{}')
          } catch {
            throw protocolError('Model tool arguments contain incomplete or invalid JSON.')
          }
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw protocolError('Model tool arguments must describe an object.')
          return {
            id: value.id || `call_${randomUUID()}`,
            name: value.name,
            arguments: value.arguments || '{}'
          }
        })
      options.onNativeToolCalls?.(calls)
    }
    accepted = true
  } catch (error) {
    failure = {
      reason: options.signal?.aborted
        ? 'cancelled'
        : error instanceof ModelStreamError && error.code === 'MODEL_STREAM_LIMIT'
          ? 'output-limit'
          : error instanceof ModelStreamError && error.code === 'MODEL_STREAM_PROTOCOL_ERROR'
            ? 'protocol-error'
            : finishReason === 'length'
              ? 'output-limit'
              : finishReason === 'content_filter'
                ? 'content-filter'
                : 'connection-closed',
      ...(error instanceof ModelStreamError ? { code: error.code } : {})
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortReader)
    try {
      await reader.cancel()
    } catch {
      /* Already closed or aborted. */
    }
    reader.releaseLock()
    options.onFinish?.(finishReason, accepted, failure)
  }
}

const LIST_MODELS_TIMEOUT_MS = 2_500

export async function listOpenAIModels(baseUrl: string, apiKey?: string | null): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, '')
  if (!root) throw new Error('Base URL is required')
  const url = root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res: Response
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS)
        : undefined
    res = await fetch(url, { headers, signal })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot reach ${url} — is the server running? (${message})`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const snippet = text.slice(0, 160).replace(/\s+/g, ' ')
    throw new Error(`List models failed: HTTP ${res.status}${snippet ? ` · ${snippet}` : ''}`)
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> }
  return (data.data ?? []).map((m) => m.id).filter(Boolean)
}
