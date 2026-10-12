import { createHash } from 'crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync
} from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { config } from './config.js'

/**
 * Composer Full (7B) — runs inside the Cloud Agent container.
 * Desktop Eris keeps Composer Lite locally; cloud jobs use this heavier model.
 */
export const LOCAL_MODEL = {
  id: 'composer',
  name: 'Composer Full',
  filename: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
  downloadUrl:
    'https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
  approxBytes: 4_683_074_336,
  sha256: '1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6'
}

export type LocalModelStatus = 'missing' | 'downloading' | 'ready' | 'error'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

let status: LocalModelStatus = 'missing'
let statusError: string | null = null
let ensurePromise: Promise<string> | null = null
let runtimePromise: Promise<NonNullable<typeof llamaRuntime>> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llamaRuntime: { model: any; context: any; LlamaChatSession: any; gpu: string | false } | null =
  null

/** Per-job chat sessions — keeps KV cache warm across tool steps. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jobSessions = new Map<string, { session: any; sequence: any }>()

/** Serialize llama use — one context sequence pool. */
let chatGate: Promise<void> = Promise.resolve()

function withChatLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chatGate.then(fn, fn)
  chatGate = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function localModelDir(): string {
  return join(config.dataDir, 'models')
}

export function localModelPath(): string {
  return join(localModelDir(), LOCAL_MODEL.filename)
}

export function getLocalModelStatus(): {
  status: LocalModelStatus
  modelId: string
  modelName: string
  path: string
  error?: string | null
  /** Active llama.cpp backend once loaded: cuda | vulkan | metal | false (CPU) */
  gpu?: string | false | null
  cached: boolean
} {
  return {
    status,
    modelId: LOCAL_MODEL.id,
    modelName: LOCAL_MODEL.name,
    path: localModelPath(),
    error: statusError,
    gpu: llamaRuntime ? llamaRuntime.gpu : null,
    cached: Boolean(llamaRuntime)
  }
}

async function sha256FileStream(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export function modelFileLooksReady(path: string = localModelPath()): boolean {
  try {
    if (!existsSync(path)) return false
    const st = statSync(path)
    return st.size > LOCAL_MODEL.approxBytes * 0.9
  } catch {
    return false
  }
}

async function downloadModel(dest: string): Promise<void> {
  status = 'downloading'
  statusError = null
  mkdirSync(localModelDir(), { recursive: true })
  const partial = `${dest}.partial`

  let existing = 0
  if (existsSync(partial)) {
    try {
      existing = statSync(partial).size
    } catch {
      existing = 0
    }
    if (existing > 0 && existing < 1024 * 1024) {
      try {
        unlinkSync(partial)
      } catch {
        // ignore
      }
      existing = 0
    }
  }

  const headers: Record<string, string> = { 'User-Agent': 'eris-cloud-agent' }
  if (existing > 0) headers.Range = `bytes=${existing}-`

  const res = await fetch(LOCAL_MODEL.downloadUrl, {
    headers,
    redirect: 'follow'
  })

  if (existing > 0 && res.status === 416) {
    // Already complete according to server — verify below
  } else if (existing > 0 && res.status === 200) {
    try {
      unlinkSync(partial)
    } catch {
      // ignore
    }
    existing = 0
  } else if (!res.ok && res.status !== 206) {
    throw new Error(`Model download failed (${res.status})`)
  }

  if (res.body && (res.status === 200 || res.status === 206)) {
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
    await pipeline(
      nodeStream,
      createWriteStream(partial, { flags: existing > 0 && res.status === 206 ? 'a' : 'w' })
    )
  }

  if (!existsSync(partial)) {
    throw new Error('Model download produced no file')
  }

  const size = statSync(partial).size
  if (size < LOCAL_MODEL.approxBytes * 0.9) {
    throw new Error(
      `Model download incomplete (${size} bytes; expected ~${LOCAL_MODEL.approxBytes})`
    )
  }

  const digest = await sha256FileStream(partial)
  if (digest !== LOCAL_MODEL.sha256) {
    try {
      unlinkSync(partial)
    } catch {
      // ignore
    }
    throw new Error(`Model checksum mismatch (got ${digest.slice(0, 12)}…)`)
  }
  renameSync(partial, dest)
}

/** Ensure GGUF is on disk (download once). Returns absolute path. */
export async function ensureLocalModel(): Promise<string> {
  const path = localModelPath()
  if (modelFileLooksReady(path)) {
    status = 'ready'
    return path
  }
  if (!ensurePromise) {
    ensurePromise = (async () => {
      try {
        await downloadModel(path)
        status = 'ready'
        return path
      } catch (err) {
        status = 'error'
        statusError = err instanceof Error ? err.message : String(err)
        ensurePromise = null
        throw err
      }
    })()
  }
  return ensurePromise
}

function llamaThreadOpts(): { maxThreads?: number } {
  if (!config.maxThreads || config.maxThreads <= 0) return {}
  return { maxThreads: config.maxThreads }
}

async function createLlama() {
  const llamaCpp = await import('node-llama-cpp')
  const { getLlama } = llamaCpp
  const mode = config.gpu
  const threads = llamaThreadOpts()

  if (mode === 'false') {
    return getLlama({ gpu: false, ...threads })
  }

  try {
    if (mode === 'cuda' || mode === 'vulkan') {
      return await getLlama({ gpu: mode, ...threads })
    }
    return await getLlama({ ...threads })
  } catch (err) {
    console.warn(
      `[eris-cloud-agent] GPU init failed (${mode}), falling back to CPU:`,
      err instanceof Error ? err.message : err
    )
    const cpuThreads =
      config.maxThreads && config.maxThreads > 0 ? { maxThreads: config.maxThreads } : { maxThreads: 2 }
    return getLlama({ gpu: false, ...cpuThreads })
  }
}

async function ensureRuntime(): Promise<NonNullable<typeof llamaRuntime>> {
  if (llamaRuntime) return llamaRuntime
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const path = await ensureLocalModel()
      const llamaCpp = await import('node-llama-cpp')
      const { LlamaChatSession } = llamaCpp
      const llama = await createLlama()
      const model = await llama.loadModel({ modelPath: path })
      const contextOpts: { contextSize: number; threads?: number } = {
        contextSize: config.contextSize
      }
      if (config.maxThreads && config.maxThreads > 0) {
        contextOpts.threads = config.maxThreads
      }
      const context = await model.createContext(contextOpts)
      const gpu = (llama.gpu ?? false) as string | false
      console.log(
        `[eris-cloud-agent] Local model ready · ${LOCAL_MODEL.name} · gpu=${
          gpu === false ? 'cpu' : gpu
        } · threads=${config.maxThreads || 'auto'} · ctx=${config.contextSize} · cached`
      )
      llamaRuntime = { model, context, LlamaChatSession, gpu }
      status = 'ready'
      return llamaRuntime
    })().catch((err) => {
      runtimePromise = null
      throw err
    })
  }
  return runtimePromise
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

async function getOrCreateJobSession(
  sessionKey: string,
  systemPrompt?: string
): Promise<{ session: any; sequence: any }> {
  const existing = jobSessions.get(sessionKey)
  if (existing && !existing.session.disposed) return existing

  const runtime = await ensureRuntime()
  const sequence = runtime.context.getSequence()
  const session = new runtime.LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: systemPrompt || undefined,
    autoDisposeSequence: false
  })
  const entry = { session, sequence }
  jobSessions.set(sessionKey, entry)
  return entry
}

/** Drop a job's chat session (keeps the loaded GGUF / context pool). */
export function releaseLocalChatSession(sessionKey: string): void {
  const entry = jobSessions.get(sessionKey)
  if (!entry) return
  jobSessions.delete(sessionKey)
  try {
    entry.session.dispose({ disposeSequence: true })
  } catch {
    try {
      entry.sequence.dispose()
    } catch {
      // ignore
    }
  }
}

/**
 * Seed a job session from checkpoint history without generating tokens.
 * Call before the next user turn after a restart/resume.
 */
export async function seedLocalChatSession(
  sessionKey: string,
  messages: ChatMessage[]
): Promise<void> {
  await withChatLock(async () => {
    releaseLocalChatSession(sessionKey)
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const { session } = await getOrCreateJobSession(sessionKey, system || undefined)
    const history = messagesToHistory(messages)
    if (history.length) {
      try {
        session.setChatHistory(history)
      } catch (err) {
        console.warn(
          '[eris-cloud-agent] setChatHistory failed; session will rebuild on next turn:',
          err instanceof Error ? err.message : err
        )
      }
    }
  })
}

export type LocalChatTurnOptions = {
  sessionKey: string
  userMessage: string
  systemPrompt?: string
  /** Default 512 for tool loops; raise for final answers. */
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Incremental chat turn that reuses the job's KV cache.
 * Model weights stay loaded in process for the lifetime of the worker.
 */
export async function localChatTurn(options: LocalChatTurnOptions): Promise<string> {
  const maxTokens = options.maxTokens ?? 512
  return withChatLock(async () => {
    const { session } = await getOrCreateJobSession(options.sessionKey, options.systemPrompt)
    const text = await session.prompt(options.userMessage, {
      temperature: 0.2,
      maxTokens,
      signal: options.signal,
      stopOnAbortSignal: true
    })
    return String(text || '').trim()
  })
}

/**
 * One-shot completion (no session reuse). Prefer localChatTurn for agent loops.
 * Still uses the cached model/context — does not reload GGUF.
 */
export async function localChatCompletion(
  messages: ChatMessage[],
  options: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const prior = messages.filter((m) => m !== lastUser)
  const key = `__oneshot_${Date.now()}_${Math.random().toString(36).slice(2)}`
  try {
    if (prior.length) await seedLocalChatSession(key, prior)
    return await localChatTurn({
      sessionKey: key,
      userMessage: lastUser?.content || 'Continue.',
      systemPrompt: prior.length ? undefined : system || undefined,
      maxTokens: options.maxTokens ?? 1024,
      signal: options.signal
    })
  } finally {
    releaseLocalChatSession(key)
  }
}

/** Kick off model prepare without blocking server listen — keeps GGUF in RAM once loaded. */
export function warmLocalModel(): void {
  if (modelFileLooksReady()) {
    status = 'ready'
    void ensureRuntime().catch((err) => {
      status = 'error'
      statusError = err instanceof Error ? err.message : String(err)
    })
    return
  }
  status = 'downloading'
  void ensureLocalModel()
    .then(() => ensureRuntime())
    .catch((err) => {
      status = 'error'
      statusError = err instanceof Error ? err.message : String(err)
    })
}
