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

let status: LocalModelStatus = 'missing'
let statusError: string | null = null
let ensurePromise: Promise<string> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llamaRuntime: { model: any; context: any; LlamaChatSession: any; gpu: string | false } | null =
  null

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
} {
  return {
    status,
    modelId: LOCAL_MODEL.id,
    modelName: LOCAL_MODEL.name,
    path: localModelPath(),
    error: statusError,
    gpu: llamaRuntime ? llamaRuntime.gpu : null
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

  // Resume interrupted downloads when the CDN supports Range requests.
  let existing = 0
  if (existsSync(partial)) {
    try {
      existing = statSync(partial).size
    } catch {
      existing = 0
    }
    // Tiny/corrupt leftovers — start clean
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
    // Server ignored Range — restart
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
  // 0 = unlimited (node-llama-cpp default). CPU default is 2 via config.
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
    // auto: let node-llama-cpp pick CUDA/Vulkan when the host exposes a GPU
    return await getLlama({ ...threads })
  } catch (err) {
    console.warn(
      `[eris-cloud-agent] GPU init failed (${mode}), falling back to CPU:`,
      err instanceof Error ? err.message : err
    )
    // Always cap threads on CPU fallback so a failed GPU path cannot peg the host.
    const cpuThreads =
      config.maxThreads && config.maxThreads > 0 ? { maxThreads: config.maxThreads } : { maxThreads: 2 }
    return getLlama({ gpu: false, ...cpuThreads })
  }
}

async function ensureRuntime(): Promise<NonNullable<typeof llamaRuntime>> {
  if (llamaRuntime) return llamaRuntime
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
    } · threads=${config.maxThreads || 'auto'} · ctx=${config.contextSize}`
  )
  llamaRuntime = { model, context, LlamaChatSession, gpu }
  status = 'ready'
  return llamaRuntime
}

export async function localChatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  const runtime = await ensureRuntime()
  const sequence = runtime.context.getSequence()
  try {
    const session = new runtime.LlamaChatSession({ contextSequence: sequence })
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join('\n\n')
      .slice(-20_000)
    const prompt = [system && `SYSTEM:\n${system.slice(0, 6000)}`, transcript, 'ASSISTANT:']
      .filter(Boolean)
      .join('\n\n')

    const text = await session.prompt(prompt, {
      temperature: 0.2,
      maxTokens: 2048,
      signal: options.signal
    })
    return String(text || '').trim()
  } finally {
    try {
      sequence.dispose()
    } catch {
      // ignore
    }
  }
}

/** Kick off model prepare without blocking server listen. */
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
