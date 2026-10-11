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

/** Same GGUF Eris ships as Composer Lite — runs inside the Cloud Agent container. */
export const LOCAL_MODEL = {
  id: 'composer-lite',
  name: 'Composer Lite',
  filename: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
  downloadUrl:
    'https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
  approxBytes: 986_048_800,
  sha256: 'f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239'
}

export type LocalModelStatus = 'missing' | 'downloading' | 'ready' | 'error'

let status: LocalModelStatus = 'missing'
let statusError: string | null = null
let ensurePromise: Promise<string> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llamaRuntime: { model: any; context: any; LlamaChatSession: any } | null = null

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
} {
  return {
    status,
    modelId: LOCAL_MODEL.id,
    modelName: LOCAL_MODEL.name,
    path: localModelPath(),
    error: statusError
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

async function ensureRuntime(): Promise<NonNullable<typeof llamaRuntime>> {
  if (llamaRuntime) return llamaRuntime
  const path = await ensureLocalModel()
  const llamaCpp = await import('node-llama-cpp')
  const { getLlama, LlamaChatSession } = llamaCpp
  let llama
  try {
    llama = await getLlama({ gpu: false })
  } catch {
    llama = await getLlama()
  }
  const model = await llama.loadModel({ modelPath: path })
  const context = await model.createContext({ contextSize: 8192 })
  llamaRuntime = { model, context, LlamaChatSession }
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
