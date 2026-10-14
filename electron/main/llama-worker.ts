/**
 * Electron utilityProcess entry — runs node-llama-cpp off the UI/main thread.
 * All load/chat work is serialized (context has a single sequence by default).
 */

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type Incoming =
  | { type: 'load'; modelPath: string; contextSize: number; requestId: string }
  | {
      type: 'chat'
      id: string
      messages: ChatMessage[]
      temperature: number
      maxTokens: number
      jsonSchema?: Record<string, unknown>
    }
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
const abortControllers = new Map<string, AbortController>()
/** Serialize load/chat — node-llama-cpp contexts default to 1 sequence. */
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

async function disposeContextOnly(): Promise<void> {
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

async function ensureContext(contextSize: number): Promise<void> {
  if (context) return
  if (!model) throw new Error('Model not loaded')
  context = await model.createContext({
    contextSize,
    sequences: 1
  })
  loadedContextSize = contextSize
}

async function handleLoad(
  path: string,
  contextSize: number,
  requestId: string
): Promise<void> {
  try {
    if (modelPath === path && model) {
      if (!context) await ensureContext(contextSize)
      post({ type: 'loaded', requestId })
      return
    }
    await disposeAll()
    const llamaCpp = await import('node-llama-cpp')
    const { getLlama } = llamaCpp
    try {
      llama = await getLlama()
    } catch {
      llama = await getLlama({ gpu: false })
    }
    model = await llama.loadModel({ modelPath: path })
    await ensureContext(contextSize)
    modelPath = path
    post({ type: 'loaded', requestId })
  } catch (err) {
    post({
      type: 'load-error',
      requestId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

async function runPrompt(options: {
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
    if (!context) await ensureContext(loadedContextSize)
    if (typeof context.sequencesLeft === 'number' && context.sequencesLeft < 1) {
      await disposeContextOnly()
      await ensureContext(loadedContextSize)
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let grammar: any = undefined
    if (options.jsonSchema && llama?.createGrammarForJsonSchema) {
      try {
        grammar = await llama.createGrammarForJsonSchema(options.jsonSchema)
      } catch {
        grammar = undefined
      }
    }
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
      runPrompt({
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
        // Recycle context and retry once — usually a leaked sequence from a race.
        await disposeContextOnly()
        await ensureContext(loadedContextSize)
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

function onMessage(raw: Incoming): void {
  if (!raw || typeof raw !== 'object') return
  switch (raw.type) {
    case 'load':
      enqueue(() => handleLoad(raw.modelPath, raw.contextSize, raw.requestId))
      break
    case 'chat':
      enqueue(() => handleChat(raw))
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
