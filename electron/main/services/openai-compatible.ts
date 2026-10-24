import { randomUUID } from 'crypto'
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

export type OpenAIToolDef = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export async function* streamOpenAICompatible(options: {
  baseUrl: string
  apiKey?: string | null
  model: string
  messages: ChatRequestMessage[]
  temperature: number
  signal?: AbortSignal
  onUsage?: (usage: OpenAIStreamUsage) => void
  /** The stream's finish_reason (if any) and whether it ended with a finish signal or [DONE]. */
  onFinish?: (finishReason: string | null, complete: boolean) => void
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
  if (supportsUsageHint) body.stream_options = { include_usage: true }
  if (options.tools?.length) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice || 'auto'
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Model connection failed: HTTP ${res.status} ${text}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete = false
  let finishReason: string | null = null
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        complete = true
        options.onFinish?.(finishReason, true)
        finishNativeTools()
        return
      }
      try {
        const json = JSON.parse(data) as {
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
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_tokens?: number
          }
        }
        if (json.usage && options.onUsage) {
          const promptTokens = Number(json.usage.prompt_tokens) || 0
          const completionTokens = Number(json.usage.completion_tokens) || 0
          options.onUsage({
            promptTokens,
            completionTokens,
            totalTokens: Number(json.usage.total_tokens) || promptTokens + completionTokens
          })
        }
        const choice = json.choices?.[0]
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason
          complete = true
        }
        const chunk = choice?.delta?.content
        if (chunk) yield chunk

        const deltas = choice?.delta?.tool_calls
        if (deltas?.length) {
          for (const tc of deltas) {
            const index = typeof tc.index === 'number' ? tc.index : 0
            const prev = toolAcc.get(index) || { id: '', name: '', arguments: '' }
            if (tc.id) prev.id = tc.id
            if (tc.function?.name) prev.name = tc.function.name
            if (tc.function?.arguments) prev.arguments += tc.function.arguments
            toolAcc.set(index, prev)
          }
        }
      } catch {
        // skip
      }
    }
  }

  options.onFinish?.(finishReason, complete)
  finishNativeTools()

  function finishNativeTools(): void {
    if (!options.onNativeToolCalls || toolAcc.size === 0) return
    if (!complete || finishReason === 'length' || finishReason === 'content_filter')
      throw new Error('Incomplete model tool stream; no tool actions were accepted.')
    const calls: NativeToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id || `call_${randomUUID()}`,
        name: v.name,
        arguments: v.arguments || '{}'
      }))
      .filter((c) => c.name)
    if (calls.length) options.onNativeToolCalls(calls)
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
