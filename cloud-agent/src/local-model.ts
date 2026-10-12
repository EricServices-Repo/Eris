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
  if (existsSync(partial)) {
    try {
      unlinkSync(partial)
    } catch {
      // ignore
    }
  }

  const res = await fetch(LOCAL_MODEL.downloadUrl, {
    headers: { 'User-Agent': 'eris-cloud-agent' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed (${res.status})`)
  }

  const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  await pipeline(nodeStream, createWriteStream(partial))

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

async function createLlama() {
  const llamaCpp = await import('node-llama-cpp')
  const { getLlama } = llamaCpp
  const mode = config.gpu

  if (mode === 'false') {
    return getLlama({ gpu: false })
  }

  try {
    if (mode === 'cuda' || mode === 'vulkan') {
      return await getLlama({ gpu: mode })
    }
    // auto: let node-llama-cpp pick CUDA/Vulkan when the host exposes a GPU
    return await getLlama()
  } catch (err) {
    console.warn(
      `[eris-cloud-agent] GPU init failed (${mode}), falling back to CPU:`,
      err instanceof Error ? err.message : err
    )
    return getLlama({ gpu: false })
  }
}

async function ensureRuntime(): Promise<NonNullable<typeof llamaRuntime>> {
  if (llamaRuntime) return llamaRuntime
  const path = await ensureLocalModel()
  const llamaCpp = await import('node-llama-cpp')
  const { LlamaChatSession } = llamaCpp
  const llama = await createLlama()
  const model = await llama.loadModel({ modelPath: path })
  const context = await model.createContext({ contextSize: 8192 })
  const gpu = (llama.gpu ?? false) as string | false
  console.log(
    `[eris-cloud-agent] Local model ready · ${LOCAL_MODEL.name} · gpu=${gpu === false ? 'cpu' : gpu}`
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
