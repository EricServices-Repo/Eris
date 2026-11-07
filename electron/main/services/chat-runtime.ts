import { recordNativeLatency } from './model-latency'
import { modelStreamWithAbort } from './task-deadline'
import { eligibleOutbound } from './eligible-outbound'
import { createPromptTokenCounter } from './agent/prompt-token-counter'
import { assertTaskReferences } from './reference-binding'
import { reportChatActivity } from './chat-activity'
import { contextProvenance, resolveModelCapabilities } from './model-capabilities'
import {
  compileModelMessages,
  budgetModelMessages,
  modelPromptMessages,
  type ModelMessage
} from './model-protocol'
import { estimateContextTokens } from '../../../src/shared/token-estimate'
import type { AppSettings } from '../../../src/shared/settings-schema'
import {
  isNativeGgufRef,
  releaseLocalChatSession,
  resolveExactBuiltinRef,
  streamBuiltinChat
} from './builtin-model'
import { reportContextDispatch, reportContextUsage } from './context-dispatch'
import { isLocalRef, resolveExactLocalRef } from './local-model'
import {
  streamOpenAICompatible,
  type ChatRequestMessage,
  type NativeToolCall,
  type OpenAIToolDef
} from './openai-compatible'
import { resolveConnectionForModel } from './model-catalog'
import { modelDestination } from './model-destination'
import { streamOllamaChat } from './ollama-chat'
import {
  ACTIVE_SESSION_KEEP_ALIVE,
  KEEP_LOADED_INDEFINITELY,
  observeOllamaPlacement,
  ollamaRequestWindow,
  prepareModelWindows
} from './ollama-runtime'
import { estimateMessagesTokens, estimateTokens, recordModelUsage } from './usage-stats'
import {
  activeDiagnosticsScope,
  assertProviderCallAllowed,
  type ModelPurpose,
  type ModelTermination
} from './model-transport'

export type { NativeToolCall, OpenAIToolDef }

export type StreamModelChatOptions = {
  settings: AppSettings
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | ChatRequestMessage>
  temperature: number
  maxOutputTokens?: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  tools?: OpenAIToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  onNativeToolCalls?: (calls: NativeToolCall[]) => void
  /** Constrain built-in GGUF output to this JSON schema (grammar decoding). */
  builtinJsonSchema?: Record<string, unknown>
  /** Reuse local GGUF KV / chat session across agent steps. */
  sessionKey?: string
  /** Which pipeline stage asked; lets diagnostics adapters answer each stage separately. */
  purpose?: ModelPurpose
  /** Called once when the provider reports how generation ended. */
  onTermination?: (termination: ModelTermination) => void
}

/**
 * The single model transport entry point. A diagnostics scope substitutes its
 * adapter here; simulated settings that lose their scope are refused rather
 * than falling through to a provider. Recalled memory is rechecked here, last, so
 * every route (retries, compaction, recovery, review) sends current evidence only.
 */
export async function* streamModelChat(
  options: StreamModelChatOptions
): AsyncGenerator<string, void, unknown> {
  for (const message of options.messages) {
    const task = (message as ModelMessage).contextBundle?.referenceTask
    if (task) await assertTaskReferences(task, options.settings, options.model)
  }
  const { messages, revoked } = await eligibleOutbound(
    options.messages,
    options.model,
    options.settings
  )
  // A live local session holds its seeded prompt; only a reseed removes revoked text.
  if (revoked && options.sessionKey) releaseLocalChatSession(options.sessionKey)
  const request = { ...options, messages }
  const scope = activeDiagnosticsScope()
  if (scope) {
    reportContextDispatch({ compiled: options.messages, outbound: messages, ...request })
    yield* modelStreamWithAbort(scope.adapter.stream({ ...request, purpose: request.purpose ?? 'agent' }), options.signal)
    return
  }
  yield* modelStreamWithAbort(streamProviderChat(request), options.signal)
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

/** OpenAI-style finish_reason of a stream that ended normally. */
function apiFinishReason(finishReason: string | null): ModelTermination['reason'] {
  switch (finishReason) {
    case 'stop':
      return 'eos'
    case 'length':
      return 'output-limit'
    case 'tool_calls':
    case 'function_call':
      return 'tool-call'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'unknown'
  }
}

/** Packs for the window a load really produced, and says so when that is what failed. */
function packForAllocation(
  messages: ModelMessage[],
  allocated: ReturnType<typeof resolveModelCapabilities>,
  plannedTokens: number,
  countWire: Awaited<ReturnType<typeof createPromptTokenCounter>>['countWire']
) {
  try {
    return budgetModelMessages(messages, allocated.promptBudget, 'text-tools', countWire)
  } catch (err) {
    if (allocated.contextCeiling >= plannedTokens) throw err
    const size = (tokens: number) => tokens.toLocaleString('en-US')
    throw new Error(
      `The model loaded with a ${size(allocated.contextCeiling)}-token context instead of the planned ${size(plannedTokens)}, and this request does not fit. ${(err as Error).message} Freeing GPU memory may also help.`,
      { cause: err }
    )
  }
}

/** Provider transport only. Diagnostics live adapters call this directly. */
export async function* streamProviderChat(
  options: StreamModelChatOptions
): AsyncGenerator<string, void, unknown> {
  let model = options.model || options.settings.models.defaultModel || 'builtin:composer-lite'
  for (const message of options.messages) {
    const task = (message as ModelMessage).contextBundle?.referenceTask
    if (task) await assertTaskReferences(task, options.settings, model)
  }
  assertProviderCallAllowed(options.settings, model)
  await prepareModelWindows(options.settings, [model], options.getSecret, options.signal)
  throwIfAborted(options.signal)
  // Preparation can load/reconfigure a server model asynchronously. Validate again
  // after that await, immediately before serializing the actual provider request.
  for (const message of options.messages) {
    const task = (message as ModelMessage).contextBundle?.referenceTask
    if (task) await assertTaskReferences(task, options.settings, model)
  }
  const eligible = await eligibleOutbound(options.messages, model, options.settings)
  if (eligible.revoked && options.sessionKey) releaseLocalChatSession(options.sessionKey)
  // That check can wait on the canonical source, and nothing below it awaits before sending.
  throwIfAborted(options.signal)
  options = { ...options, messages: eligible.messages }
  if (
    options.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)
  )
    throw new Error('Invalid output-token reservation')
  const { settings: requestSettings, maxOutputTokens } = options
  const currentCapabilities = () => {
    const resolved = resolveModelCapabilities(requestSettings, model)
    if (maxOutputTokens !== undefined)
      resolved.outputCap = Math.min(resolved.outputCap, maxOutputTokens)
    return resolved
  }
  const capabilities = currentCapabilities()
  const plannedTokens = capabilities.contextCeiling
  const protocol = capabilities.tools
  const inputMessages = modelPromptMessages(
    options.messages as ModelMessage[],
    options.tools ?? [],
    protocol
  )
  const schemaTokens =
    protocol === 'text-tools' || !options.tools?.length
      ? 0
      : estimateContextTokens(JSON.stringify(options.tools))
  // A native forecast can be deliberately smaller than what placement will fit.
  // Validate the transcript now, but defer fitting until prepareMessages observes
  // the actual allocation. Otherwise a cold 262K request can fail against an 8K
  // planning forecast without ever giving the allocator a chance to run.
  const budgeted = isNativeGgufRef(model)
    ? { messages: inputMessages }
    : budgetModelMessages(inputMessages, capabilities.promptBudget - schemaTokens, protocol)
  let compiled = compileModelMessages(budgeted.messages, {
    protocol,
    contextWindow: capabilities.contextCeiling,
    outputReserve: capabilities.outputReserve
  })
  if (!isNativeGgufRef(model))
    reportContextDispatch({
      compiled: options.messages,
      outbound: compiled,
      adapted: true,
      ...options,
      context: contextProvenance(options.settings, model)
    })
  let inputEstimate =
    estimateMessagesTokens(
      compiled.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content ?? ''
      }))
    ) + schemaTokens
  const purpose = options.purpose ?? 'agent'
  const phase = (value: 'loading' | 'prefill' | 'generating' | 'integrating', reason: string) =>
    reportChatActivity(
      purpose === 'intent' || purpose === 'route'
        ? 'routing'
        : purpose === 'agent' || value === 'loading'
          ? value
          : 'integrating',
      { source: 'transport', purpose, model, reason }
    )
  let firstChunk = true
  let dispatchedAt: number | undefined
  let dispatchToFirstChunkMs: number | undefined
  const dispatched = (reason: string) => {
    dispatchedAt = performance.now()
    phase('prefill', reason)
  }
  const chunkSeen = () => {
    if (firstChunk) {
      firstChunk = false
      if (dispatchedAt !== undefined) {
        dispatchToFirstChunkMs = Math.round(performance.now() - dispatchedAt)
        if (
          purpose === 'agent' &&
          isNativeGgufRef(model) &&
          !options.tools?.length &&
          inputEstimate <= 4096 &&
          !activeDiagnosticsScope()
        )
          recordNativeLatency(options.settings, model, 'warm-answer', dispatchToFirstChunkMs)
      }
      phase('generating', 'First model output chunk received')
    }
  }
  let outputText = ''
  let provider: string | null = null
  let reportedPrompt: number | null = null
  let reportedCompletion: number | null = null

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    reportContextUsage({
      compiled: options.messages,
      outbound: compiled,
      model,
      measuredPromptTokens: reportedPrompt,
      dispatchToFirstChunkMs
    })
    try {
      recordModelUsage({
        model,
        provider,
        inputTokens: reportedPrompt ?? inputEstimate,
        outputTokens: reportedCompletion ?? estimateTokens(outputText),
        inputSource: reportedPrompt === null ? 'estimated' : 'measured',
        outputSource: reportedCompletion === null ? 'estimated' : 'measured'
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
      phase('loading', 'Waiting for local resources and model readiness')
      for await (const chunk of streamBuiltinChat({
        onLoaded: () => dispatched('Local model ready; request dispatched'),
        prepareMessages: async () => {
          if (purpose === 'agent')
            reportChatActivity('prompt', {
              source: 'transport',
              purpose,
              model,
              reason: 'Packing and validating native input'
            })
          throwIfAborted(options.signal)
          for (const message of options.messages) {
            const task = (message as ModelMessage).contextBundle?.referenceTask
            if (task) await assertTaskReferences(task, options.settings, model)
          }
          const countable = await eligibleOutbound(options.messages, model, options.settings)
          if (countable.revoked && options.sessionKey) releaseLocalChatSession(options.sessionKey)
          const counter = await createPromptTokenCounter(
            model,
            countable.messages as ModelMessage[],
            options.tools ?? [],
            'text-tools',
            options.signal
          )
          // Tokenization may wait on the worker. Recheck source controls after it,
          // and do no more asynchronous work before returning the final prompt.
          for (const message of options.messages) {
            const task = (message as ModelMessage).contextBundle?.referenceTask
            if (task) await assertTaskReferences(task, options.settings, model)
          }
          const latest = await eligibleOutbound(options.messages, model, options.settings)
          if (latest.revoked && options.sessionKey) releaseLocalChatSession(options.sessionKey)
          throwIfAborted(options.signal)
          const allocated = currentCapabilities()
          const wire = modelPromptMessages(
            latest.messages as ModelMessage[],
            options.tools ?? [],
            'text-tools'
          )
          const packed = packForAllocation(wire, allocated, plannedTokens, counter.countWire)
          compiled = compileModelMessages(packed.messages, {
            protocol: 'text-tools',
            contextWindow: allocated.contextCeiling,
            outputReserve: allocated.outputReserve
          })
          Object.assign(capabilities, allocated)
          inputEstimate = estimateMessagesTokens(
            compiled.map((m) => ({
              role: m.role === 'tool' ? 'user' : m.role,
              content: m.content ?? ''
            }))
          )
          reportContextDispatch({
            ...options,
            compiled: latest.messages,
            outbound: compiled,
            adapted: true,
            context: {
              ...contextProvenance(options.settings, model),
              ...(allocated.contextCeiling === plannedTokens ? {} : { plannedTokens })
            }
          })
          return compiled
            .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'system' | 'user' | 'assistant',
              content: String(m.content ?? '')
            }))
        },
        modelRef: model,
        contextWindow: capabilities.requestedContext,
        maxOutputTokens: capabilities.outputCap,
        messages: compiled
          .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : ''
          })),
        temperature: options.temperature,
        signal: options.signal,
        jsonSchema: options.builtinJsonSchema,
        sessionKey: options.sessionKey,
        onTermination: (termination) => {
          reportedPrompt = termination.promptTokens ?? null
          reportedCompletion = termination.outputTokens ?? null
          options.onTermination?.({
            ...termination,
            capabilities,
            inputTokenSource: reportedPrompt === null ? 'unavailable' : 'measured',
            outputTokenSource: reportedCompletion === null ? 'unavailable' : 'measured'
          })
        }
      })) {
        if (chunk) chunkSeen()
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
    dispatched('Provider request dispatched; network time is included')
    const numCtx = ollamaRequestWindow(connection, model, capabilities.requestedContext)
    const stream =
      numCtx === null
        ? streamOpenAICompatible
        : (request: Parameters<typeof streamOpenAICompatible>[0]) =>
            streamOllamaChat({
              ...request,
              numCtx,
              keepAlive: connection.keepModelLoaded
                ? KEEP_LOADED_INDEFINITELY
                : ACTIVE_SESSION_KEEP_ALIVE
            })
    for await (const chunk of stream({
      baseUrl: connection.baseUrl,
      apiKey,
      model,
      messages: compiled,
      temperature: options.temperature,
      maxOutputTokens: capabilities.outputCap,
      signal: options.signal,
      refuseRedirects: modelDestination(options.settings, model).recallAllowed,
      tools: protocol === 'native-tools' ? options.tools : undefined,
      toolChoice: options.toolChoice,
      onNativeToolCalls: options.onNativeToolCalls,
      onUsage: (usage) => {
        reportedPrompt = usage.promptTokens
        reportedCompletion = usage.completionTokens
      },
      onFinish: options.onTermination
        ? (finishReason, complete, failure) =>
            options.onTermination!({
              reason: complete
                ? apiFinishReason(finishReason)
                : (failure?.reason ?? 'connection-closed'),
              ...(failure?.code ? { failureCode: failure.code } : {}),
              capabilities,
              maxOutputTokens: capabilities.outputCap,
              inputTokenSource: reportedPrompt === null ? 'unavailable' : 'measured',
              outputTokenSource: reportedCompletion === null ? 'unavailable' : 'measured',
              ...(finishReason ? { raw: finishReason } : {}),
              ...(reportedPrompt !== null ? { promptTokens: reportedPrompt } : {}),
              ...(reportedCompletion !== null ? { outputTokens: reportedCompletion } : {})
            })
        : undefined
    })) {
      if (chunk) chunkSeen()
      outputText += chunk
      yield chunk
    }
    finish()
    if (numCtx !== null) void observeOllamaPlacement(connection, model, numCtx, apiKey)
  } catch (err) {
    reportChatActivity('integrating', {
      source: 'transport',
      purpose,
      origin:
        (err as { code?: string }).code === 'INFERENCE_QUEUE_TIMEOUT'
          ? 'inference-queue'
          : (err as { code?: string }).code === 'LOCAL_MODEL_WORKER_FAILED'
            ? 'local-worker'
            : options.signal?.aborted
              ? 'cancelled'
              : 'provider',
      errorCode: (err as { code?: string }).code ?? 'UNCLASSIFIED',
      reason: 'Model call did not complete; preserving partial evidence'
    })
    throw err
  } finally {
    // An agent can close a stream as soon as a complete tool call arrives.
    if (outputText) finish()
  }
}
