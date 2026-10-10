import type { AppSettings } from '../../../src/shared/settings-schema'
import { isBuiltinRef, resolveExactBuiltinRef, streamBuiltinChat } from './builtin-model'
import {
  streamOpenAICompatible,
  type ChatRequestMessage,
  type NativeToolCall,
  type OpenAIToolDef
} from './openai-compatible'
import { resolveConnectionForModel } from './model-catalog'
import {
  estimateMessagesTokens,
  estimateTokens,
  recordModelUsage
} from './usage-stats'

export type { NativeToolCall, OpenAIToolDef }

export async function* streamModelChat(options: {
  settings: AppSettings
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | ChatRequestMessage>
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  tools?: OpenAIToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  onNativeToolCalls?: (calls: NativeToolCall[]) => void
}): AsyncGenerator<string, void, unknown> {
  let model =
    options.model || options.settings.models.defaultModel || 'builtin:composer-lite'
  const inputEstimate = estimateMessagesTokens(
    options.messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: typeof m.content === 'string' ? m.content : ''
    }))
  )
  let outputText = ''
  let provider: string | null = null
  let reportedPrompt: number | null = null
  let reportedCompletion: number | null = null

  const finish = () => {
    try {
      recordModelUsage({
        model,
        provider,
        inputTokens: reportedPrompt ?? inputEstimate,
        outputTokens: reportedCompletion ?? estimateTokens(outputText)
      })
    } catch {
      /* never break chat on usage accounting */
    }
  }

  try {
    if (isBuiltinRef(model)) {
      const ready = resolveExactBuiltinRef(model)
      if (!ready) {
        throw new Error(
          `Built-in model “${model}” is not ready. Open Settings → Models and download it.`
        )
      }
      model = ready
      provider = 'builtin'
      for await (const chunk of streamBuiltinChat({
        modelRef: model,
        messages: options.messages
          .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : ''
          })),
        temperature: options.temperature,
        signal: options.signal
      })) {
        outputText += chunk
        yield chunk
      }
      finish()
      return
    }

    const connection = resolveConnectionForModel(options.settings, model)
    if (!connection || connection.type !== 'openai-compatible') {
      throw new Error(
        `No model connection for “${model}”. Connect Ollama or another API in Settings → Models (Refresh models after ollama pull), or download Composer Lite.`
      )
    }
    if (!connection.baseUrl) {
      throw new Error(`Connection “${connection.name}” has no base URL`)
    }

    provider = connection.provider || connection.name || 'custom'
    const apiKey = connection.apiKeyRef ? options.getSecret(connection.apiKeyRef) : null
    for await (const chunk of streamOpenAICompatible({
      baseUrl: connection.baseUrl,
      apiKey,
      model,
      messages: options.messages as ChatRequestMessage[],
      temperature: options.temperature,
      signal: options.signal,
      tools: options.tools,
      toolChoice: options.toolChoice,
      onNativeToolCalls: options.onNativeToolCalls,
      onUsage: (usage) => {
        reportedPrompt = usage.promptTokens
        reportedCompletion = usage.completionTokens
      }
    })) {
      outputText += chunk
      yield chunk
    }
    finish()
  } catch (err) {
    // Still count partial output if the stream produced anything before failing
    if (outputText) finish()
    throw err
  }
}
