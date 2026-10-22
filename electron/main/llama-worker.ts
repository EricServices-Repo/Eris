/**
 * Electron utilityProcess entry — runs node-llama-cpp off the UI/main thread.
 * All load/chat work is serialized. Job sessions keep KV warm across agent steps.
 */

import { contextCreateOptions, isMemoryError, modelLoadOptions } from './services/vram-fit'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type Incoming =
  | {
      type: 'load'
      modelPath: string
      contextSize: number
      contextMin?: number
      requestId: string
      preferEgpu?: boolean
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

function messagesToHistory(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') out.push({ type: 'system', text: m.content })
    else if (m.role === 'user') out.push({ type: 'user', text: m.content })
    else out.push({ type: 'model', response: [m.content] })
  }
  return out
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
  try {
    context = await model.createContext(contextCreateOptions(plan.min, plan.max, true))
  } catch {
    context = await model.createContext(contextCreateOptions(plan.min, plan.max, false))
  }
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
  minContext?: number
): Promise<void> {
  try {
    contextMax = Math.max(512, contextSize)
    contextMin = Math.min(contextMax, Math.max(512, minContext ?? contextSize))
    if (modelPath === path && model) {
      if (!context) await ensureContext()
      post({ type: 'loaded', requestId, gpu: llama?.gpu ?? null })
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
    try {
      model = await llama.loadModel(modelLoadOptions(path, contextMax, false))
    } catch (err) {
      if (!isMemoryError(err) || llama.gpu === false) throw err
      model = await llama.loadModel(modelLoadOptions(path, contextMax, true))
    }
    await ensureContext()
    modelPath = path
    post({ type: 'loaded', requestId, gpu: llama?.gpu ?? null })
  } catch (err) {
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

/** Legacy oneshot: flatten full transcript, dispose sequence after. */
async function runPromptOneshot(options: {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  signal: AbortSignal
  jsonSchema?: Record<string, unknown>
  onChunk: (text: string) => void
}): Promise<void> {
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

    const system = options.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const transcript = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join('\n\n')
      .slice(-24_000)
    const prompt = [system && `SYSTEM:\n${system.slice(0, 8000)}`, transcript, 'ASSISTANT:']
      .filter(Boolean)
      .join('\n\n')

    const grammar = await buildGrammar(options.jsonSchema)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptOpts: any = {
      temperature: options.temperature,
      signal: options.signal,
      maxTokens: options.maxTokens,
      ...(grammar ? { grammar } : {}),
      onTextChunk(chunk: string) {
        options.onChunk(chunk)
      }
    }
    await session.prompt(prompt, promptOpts)
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
}): Promise<void> {
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
    session.setChatHistory(messagesToHistory(options.seedMessages))
  }
  const grammar = await buildGrammar(options.jsonSchema)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const promptOpts: any = {
    temperature: options.temperature,
    signal: options.signal,
    maxTokens: options.maxTokens,
    stopOnAbortSignal: true,
    ...(grammar ? { grammar } : {}),
    onTextChunk(chunk: string) {
      options.onChunk(chunk)
    }
  }
  await session.prompt(options.userMessage, promptOpts)
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

    try {
      await run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/no sequences left/i.test(message) && !ac.signal.aborted) {
        await disposeContextOnly()
        await ensureContext()
        await run()
      } else {
        throw err
      }
    }

    if (ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'done', id: msg.id })
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

    try {
      await run()
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
        await run()
      } else {
        throw err
      }
    }

    if (ac.signal.aborted) {
      post({ type: 'error', id: msg.id, error: 'Aborted' })
    } else {
      post({ type: 'done', id: msg.id, sessionKey: msg.sessionKey })
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
        handleLoad(raw.modelPath, raw.contextSize, raw.requestId, raw.gpu ?? 'auto', raw.contextMin)
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
