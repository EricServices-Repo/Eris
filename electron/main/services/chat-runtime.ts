import { contextBudgetTokens } from './agent/context-budget'
import { compileModelMessages, budgetModelMessages, type ModelMessage } from './model-protocol'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { isNativeGgufRef, resolveExactBuiltinRef, streamBuiltinChat } from './builtin-model'
import { isLocalRef, resolveExactLocalRef } from './local-model'
import {
  streamOpenAICompatible,
  type ChatRequestMessage,
  type NativeToolCall,
  type OpenAIToolDef
} from './openai-compatible'
import { resolveConnectionForModel } from './model-catalog'
import { estimateMessagesTokens, estimateTokens, recordModelUsage } from './usage-stats'

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
  /** Constrain built-in GGUF output to this JSON schema (grammar decoding). */
  builtinJsonSchema?: Record<string, unknown>
  /** Reuse local GGUF KV / chat session across agent steps. */
  sessionKey?: string
}): AsyncGenerator<string, void, unknown> {
  let model = options.model || options.settings.models.defaultModel || 'builtin:composer-lite'
  const protocol = isNativeGgufRef(model)
    ? 'text-tools'
    : (resolveConnectionForModel(options.settings, model)?.toolProtocol ?? 'native-tools')
  const inputMessages = options.messages.map((message) => ({
    ...message,
    content: message.content ?? ''
  })) as ModelMessage[]
  if (protocol === 'text-tools' && options.tools?.length)
    inputMessages.splice(1, 0, {
      role: 'system',
      content:
        'Available tools (JSON schemas):\n' +
        JSON.stringify(options.tools.map((tool) => tool.function))
    })
  const schemaTokens =
    protocol === 'text-tools' ? 0 : Math.ceil(JSON.stringify(options.tools ?? []).length / 3)
  const budgeted = budgetModelMessages(
    inputMessages,
    Math.max(512, contextBudgetTokens(options.settings, model) - schemaTokens)
  )
  const compiled = compileModelMessages(budgeted.messages, {
    protocol,
    contextWindow: options.settings.models.contextWindow || 8192,
    outputReserve: 1024
  })
  const inputEstimate =
    estimateMessagesTokens(
      compiled.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content ?? ''
      }))
    ) + schemaTokens
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
    if (isNativeGgufRef(model)) {
      if (isLocalRef(model)) {
        const ready = resolveExactLocalRef(model)
        if (!ready) {
          throw new Error(
            `Local model “${model}” is not ready. Open Settings → Models → Local and download it.`
          )
        }
        model = ready
        provider = 'local'
      } else {
        const ready = resolveExactBuiltinRef(model)
        if (!ready) {
          throw new Error(
            `Built-in model “${model}” is not ready. Open Settings → Models and download it.`
          )
        }
        model = ready
        provider = 'builtin'
      }
      for await (const chunk of streamBuiltinChat({
        modelRef: model,
        messages: compiled
          .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : ''
          })),
        temperature: options.temperature,
        signal: options.signal,
        jsonSchema: options.builtinJsonSchema,
        sessionKey: options.sessionKey
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
      messages: compiled,
      temperature: options.temperature,
      signal: options.signal,
      tools: protocol === 'native-tools' ? options.tools : undefined,
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
