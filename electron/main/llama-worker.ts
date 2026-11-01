/**
 * Electron utilityProcess entry — runs node-llama-cpp off the UI/main thread.
 * All load/chat work is serialized. Job sessions keep KV warm across agent steps.
 */

import { allocationFacts, createContextWithVramFallback, placeModel } from './services/vram-fit'
import {
  messagesToLlamaHistory,
  nativeStopReason,
  oneShotPrompt,
  replyTokenAllowance
} from '../../src/shared/llama-session'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type Incoming =
  | { type: 'tokenize'; requestId: string; texts: string[] }
  | {
      type: 'load'
      modelPath: string
      contextSize: number
      contextMin?: number
      requestId: string
      preferEgpu?: boolean
      allowCpuSpill?: boolean
      gpu?: 'auto' | 'metal' | 'cuda' | 'vulkan' | false
    }
  | {
      type: 'chat'
      id: string
      messages: ChatMessage[]
      temperature: number
      maxTokens: number
      jsonSchema?: Record<string, unknown>
    }
  | {
      type: 'chat-turn'
      id: string
      sessionKey: string
      userMessage: string
      /** Authoritative history before this turn, including for reused sessions. */
      seedMessages?: ChatMessage[]
      systemPrompt?: string
      temperature: number
      maxTokens: number
      jsonSchema?: Record<string, unknown>
    }
  | { type: 'chat-release'; sessionKey: string }
  | { type: 'abort'; id: string }
  | { type: 'dispose' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llama: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let model: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let context: any = null
let modelPath: string | null = null
let loadedContextSize = 4096
let contextMin = 4096
let contextMax = 16384
const abortControllers = new Map<string, AbortController>()
/** Per-chat-run sessions — keep KV cache warm across tool steps. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jobSessions = new Map<string, { session: any; sequence: any }>()
/** Serialize load/chat — node-llama-cpp contexts have a small sequence pool. */
let chain: Promise<void> = Promise.resolve()

function post(msg: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const port = (process as any).parentPort
  if (port?.postMessage) port.postMessage(msg)
  else if (typeof process.send === 'function') process.send(msg)
}

function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn, fn).then(
    () => undefined,
    () => undefined
  )
}

function releaseSession(sessionKey: string): void {
  const entry = jobSessions.get(sessionKey)
  if (!entry) return
  jobSessions.delete(sessionKey)
  try {
    entry.session.dispose?.({ disposeSequence: true })
  } catch {
    try {
      entry.sequence?.dispose?.()
    } catch {
      // ignore
    }
  }
}

function releaseAllSessions(): void {
  for (const key of [...jobSessions.keys()]) releaseSession(key)
}

async function disposeContextOnly(): Promise<void> {
  releaseAllSessions()
  try {
    await context?.dispose?.()
  } catch {
    // ignore
  }
  context = null
}

async function disposeAll(): Promise<void> {
  for (const ac of abortControllers.values()) ac.abort()
  abortControllers.clear()
  await disposeContextOnly()
  try {
    await model?.dispose?.()
  } catch {
    // ignore
  }
  model = null
  llama = null
  modelPath = null
}

async function ensureContext(): Promise<void> {
  if (context) return
  if (!model) throw new Error('Model not loaded')
  const plan = { min: contextMin, max: contextMax }
  context = await createContextWithVramFallback((options) => model.createContext(options), plan)
  loadedContextSize = typeof context.contextSize === 'number' ? context.contextSize : contextMax
}

async function getOrCreateSession(
  sessionKey: string,
  systemPrompt?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ session: any; sequence: any }> {
  const existing = jobSessions.get(sessionKey)
  if (existing && !existing.session.disposed) return existing

  const llamaCpp = await import('node-llama-cpp')
  const { LlamaChatSession } = llamaCpp
  if (!context) await ensureContext()
  if (typeof context.sequencesLeft === 'number' && context.sequencesLeft < 1) {
    // Drop idle sessions that may be leaking sequences, then retry once.
    if (jobSessions.size > 0) {
      for (const [key, entry] of jobSessions) {
        if (key === sessionKey) continue
        try {
          entry.session.dispose?.({ disposeSequence: true })
        } catch {
          // ignore
        }
        jobSessions.delete(key)
      }
    }
    if (typeof context.sequencesLeft === 'number' && context.sequencesLeft < 1) {
      await disposeContextOnly()
      await ensureContext()
    }
  }
  const sequence = context.getSequence()
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: systemPrompt || undefined,
    autoDisposeSequence: false
  })
  const entry = { session, sequence }
  jobSessions.set(sessionKey, entry)
  return entry
}

async function handleLoad(
  path: string,
  contextSize: number,
  requestId: string,
  gpu: 'auto' | 'metal' | 'cuda' | 'vulkan' | false = 'auto',
  minContext?: number,
  allowCpuSpill = true
): Promise<void> {
  try {
    contextMax = Math.max(512, contextSize)
    contextMin = Math.min(contextMax, Math.max(512, minContext ?? contextSize))
    if (modelPath === path && model) {
      if (!context) await ensureContext()
      post({
        type: 'loaded',
        requestId,
        gpu: llama?.gpu ?? null,
        ...allocationFacts(model, context)
      })
      return
    }
    await disposeAll()
    const llamaCpp = await import('node-llama-cpp')
    const { getLlama } = llamaCpp
    try {
      llama = await getLlama({ gpu, progressLogs: false })
    } catch {
      llama = await getLlama({ gpu: false, progressLogs: false })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const placed = await placeModel<any, any>({
      load: (options) => llama.loadModel(options),
      createContext: (loaded, options) => loaded.createContext(options),
      disposeModel: async (loaded) => {
        await loaded.dispose?.()
      },
      modelPath: path,
      plan: { min: contextMin, target: contextMax },
      gpu: llama.gpu !== false,
      allowCpuSpill
    })
    model = placed.model
    context = placed.context
    // A later context rebuild must not ask for more than placement found room for.
    if (typeof context.contextSize === 'number') {
      contextMax = context.contextSize
      contextMin = Math.min(contextMin, contextMax)
      loadedContextSize = contextMax
    }
    modelPath = path
    post({
      type: 'loaded',
      requestId,
      gpu: llama?.gpu ?? null,
      placement: placed.placement,
      ...allocationFacts(model, context)
    })
  } catch (err) {
    // A failed context allocation must not leave model weights occupying VRAM.
    await disposeAll()
    post({
      type: 'load-error',
      requestId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

async function buildGrammar(jsonSchema?: Record<string, unknown>): Promise<unknown> {
  if (!jsonSchema) return undefined
  if (!llama?.createGrammarForJsonSchema)
    throw new Error('This local runtime cannot enforce the requested tool schema.')
  return await llama.createGrammarForJsonSchema(jsonSchema)
}

function nativeTokenCounts(texts: string[]): number[] | null {
  try {
    if (!model?.tokenize) return null
    return texts.map((text) => (model.tokenize(text) as ArrayLike<number>).length)
  } catch {
    return null
  }
}

function countTokens(text: string): number {
  try {
    const tokens = model?.tokenize?.(text)
    if (Array.isArray(tokens) || ArrayBuffer.isView(tokens))
      return (tokens as ArrayLike<number>).length
  } catch {
    // fall back to the estimate below
  }
  return Math.ceil(text.length / 3)
}

/** Effective reply limit and prompt size for one request; reported with its stop reason. */
function replyBudget(
  requested: number,
  messages: ChatMessage[]
): { maxTokens: number; promptTokens: number } {
  // Template framing adds a few tokens per message beyond the text itself.
  const promptTokens =
    countTokens(messages.map((message) => message.content).join('\n')) + messages.length * 8
  return {
    promptTokens,
    maxTokens: replyTokenAllowance({ requested, contextSize: loadedContextSize, promptTokens })
  }
}

export interface WorkerTermination {
  reason: ReturnType<typeof nativeStopReason>
  raw?: string
  maxOutputTokens: number
  promptTokens: number
  contextTokens: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function promptWithStopReason(session: any, text: string, opts: any): Promise<unknown> {
  if (typeof session.promptWithMeta === 'function') {
    const meta = await session.promptWithMeta(text, opts)
    return meta?.stopReason
  }
  await session.prompt(text, opts)
  return undefined
}

/** One-shot: the same structured history as a session turn, sequence disposed after. */
async function runPromptOneshot(options: {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  signal: AbortSignal
  jsonSchema?: Record<string, unknown>
  onChunk: (text: string) => void
}): Promise<WorkerTermination> {
  const llamaCpp = await import('node-llama-cpp')
  const { LlamaChatSession } = llamaCpp
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sequence: any = null
  try {
    if (!context) await ensureContext()
    if (typeof context.sequencesLeft === 'number' && context.sequencesLeft < 1) {
      await disposeContextOnly()
      await ensureContext()
    }
    sequence = context.getSequence()
    const session = new LlamaChatSession({ contextSequence: sequence })
    // Budgeting happened once, upstream; no independent character slicing here.
    const { history, userMessage } = oneShotPrompt(options.messages)
    session.setChatHistory(messagesToLlamaHistory(history) as never)
    const budget = replyBudget(options.maxTokens, options.messages)

    const grammar = await buildGrammar(options.jsonSchema)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptOpts: any = {
      temperature: options.temperature,
      signal: options.signal,
      maxTokens: budget.maxTokens,
      ...(grammar ? { grammar } : {}),
      onTextChunk(chunk: string) {
        options.onChunk(chunk)
      }
    }
    const raw = await promptWithStopReason(session, userMessage, promptOpts)
    return {
      reason: nativeStopReason(raw),
      ...(typeof raw === 'string' ? { raw } : {}),
      maxOutputTokens: budget.maxTokens,
      promptTokens: budget.promptTokens,
      contextTokens: loadedContextSize
    }
  } finally {
    try {
      await sequence?.dispose?.()
    } catch {
      // ignore
    }
  }
}

async function runSessionTurn(options: {
  sessionKey: string
  userMessage: string
  seedMessages?: ChatMessage[]
  systemPrompt?: string
  temperature: number
  maxTokens: number
  signal: AbortSignal
  jsonSchema?: Record<string, unknown>
  onChunk: (text: string) => void
}): Promise<WorkerTermination> {
  const existing = jobSessions.get(options.sessionKey)
  const isNew = !existing || existing.session.disposed

  if (isNew) {
    const system =
      options.systemPrompt ||
      options.seedMessages
        ?.filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n') ||
      undefined
    await getOrCreateSession(options.sessionKey, system)
  }

  const { session } = await getOrCreateSession(options.sessionKey)
  if (options.seedMessages !== undefined) {
    // Synchronization failure must not silently generate against stale history.
    session.setChatHistory(messagesToLlamaHistory(options.seedMessages))
  }
  const budget = replyBudget(options.maxTokens, [
    ...(options.seedMessages ?? []),
    { role: 'user', content: options.userMessage }
  ])
  const grammar = await buildGrammar(options.jsonSchema)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const promptOpts: any = {
    temperature: options.temperature,
    signal: options.signal,
    maxTokens: budget.maxTokens,
    stopOnAbortSignal: true,
    ...(grammar ? { grammar } : {}),
    onTextChunk(chunk: string) {
      options.onChunk(chunk)
    }
  }
  const raw = await promptWithStopReason(session, options.userMessage, promptOpts)
  return {
    reason: nativeStopReason(raw),
    ...(typeof raw === 'string' ? { raw } : {}),
    maxOutputTokens: budget.maxTokens,
    promptTokens: budget.promptTokens,
    contextTokens: loadedContextSize
  }
}

async function handleChat(msg: {
  id: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  jsonSchema?: Record<string, unknown>
}): Promise<void> {
  if (!model) {
    post({ type: 'error', id: msg.id, error: 'Model not loaded' })
    return
  }

  const ac = new AbortController()
  abortControllers.set(msg.id, ac)

  try {
    const run = () =>
      runPromptOneshot({
        messages: msg.messages,
        temperature: msg.temperature,
        maxTokens: msg.maxTokens,
        signal: ac.signal,
        jsonSchema: msg.jsonSchema,
        onChunk: (text) => post({ type: 'chunk', id: msg.id, text })
      })

    let termination: WorkerTermination | undefined
    try {
      termination = await run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/no sequences left/i.test(message) && !ac.signal.aborted) {
        await disposeContextOnly()
        await ensureContext()
        termination = await run()
      } else {
        throw err
      }
    }

    if (ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'done', id: msg.id, termination })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError' || /abort/i.test(message) || ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'error', id: msg.id, error: message })
    }
  } finally {
    abortControllers.delete(msg.id)
  }
}

async function handleChatTurn(msg: {
  id: string
  sessionKey: string
  userMessage: string
  seedMessages?: ChatMessage[]
  systemPrompt?: string
  temperature: number
  maxTokens: number
  jsonSchema?: Record<string, unknown>
}): Promise<void> {
  if (!model) {
    post({ type: 'error', id: msg.id, error: 'Model not loaded' })
    return
  }

  const ac = new AbortController()
  abortControllers.set(msg.id, ac)

  try {
    const run = () =>
      runSessionTurn({
        sessionKey: msg.sessionKey,
        userMessage: msg.userMessage,
        seedMessages: msg.seedMessages,
        systemPrompt: msg.systemPrompt,
        temperature: msg.temperature,
        maxTokens: msg.maxTokens,
        signal: ac.signal,
        jsonSchema: msg.jsonSchema,
        onChunk: (text) => post({ type: 'chunk', id: msg.id, text })
      })

    let termination: WorkerTermination | undefined
    try {
      termination = await run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Context overflow / sequence issues → drop session and retry once with full seed.
      if (
        !ac.signal.aborted &&
        (/no sequences left|context size|exceed|overflow/i.test(message) ||
          /setChatHistory/i.test(message))
      ) {
        releaseSession(msg.sessionKey)
        if (/no sequences left/i.test(message)) {
          await disposeContextOnly()
          await ensureContext()
        }
        termination = await run()
      } else {
        throw err
      }
    }

    if (ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'done', id: msg.id, sessionKey: msg.sessionKey, termination })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const name = err instanceof Error ? err.name : ''
    if (name === 'AbortError' || /abort/i.test(message) || ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'error', id: msg.id, error: message })
    }
  } finally {
    abortControllers.delete(msg.id)
  }
}

function onMessage(raw: Incoming): void {
  if (!raw || typeof raw !== 'object') return
  switch (raw.type) {
    case 'load':
      enqueue(() =>
        handleLoad(
          raw.modelPath,
          raw.contextSize,
          raw.requestId,
          raw.gpu ?? 'auto',
          raw.contextMin,
          raw.allowCpuSpill
        )
      )
      break
    case 'chat':
      enqueue(() => handleChat(raw))
      break
    case 'chat-turn':
      enqueue(() => handleChatTurn(raw))
      break
    case 'chat-release':
      enqueue(async () => {
        releaseSession(raw.sessionKey)
        post({ type: 'released', sessionKey: raw.sessionKey })
      })
      break
    case 'abort': {
      abortControllers.get(raw.id)?.abort()
      break
    }
    // Not queued: tokenizing does not use the context, so it must not wait for a reply.
    case 'tokenize':
      post({
        type: 'tokenized',
        requestId: raw.requestId,
        modelPath,
        counts: nativeTokenCounts(raw.texts)
      })
      break
    case 'dispose':
      enqueue(async () => {
        await disposeAll()
        post({ type: 'disposed' })
      })
      break
    default:
      break
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const port = (process as any).parentPort
if (port?.on) {
  port.on('message', (e: { data: Incoming }) => onMessage(e?.data ?? (e as unknown as Incoming)))
} else {
  process.on('message', (msg: Incoming) => onMessage(msg))
}

post({ type: 'ready' })
