import { createHash } from 'crypto'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import type {
  AppSettings,
  BuiltinModelManifestEntry,
  BuiltinModelStatus
} from '../../../src/shared/settings-schema'
import { builtinModelsDir, modelsManifestPath } from './paths'
import { logError, logInfo, logWarn } from './logger'
import {
  attachIdleTimeout,
  bodyToNodeStream,
  createThrottledProgress,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  downloadFetch,
  formatDownloadNetworkError,
  publishDownloadedFile,
  resolveDownloadTotal,
  type DownloadPhase
} from './http-download'
import {
  applyLlamaGpuPreference,
  noteLlamaBackend,
  type LlamaGpuBackend
} from './gpu-accel'
import { getResolvedSettings } from './settings'
import {
  contextCreateOptions,
  contextLimits,
  REPLY_MAX_TOKENS,
  isMemoryError,
  modelLoadOptions
} from './vram-fit'
import { appState } from '../app-state'
import { messagesToLlamaHistory, splitSessionPrompt } from '../../../src/shared/llama-session'

type LlamaModule = typeof import('node-llama-cpp')

const MAX_GGUF_STRING = 16 * 1024 * 1024
const MAX_GGUF_ARRAY = 2_000_000

function formatApproxSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${bytes} B`
}

interface RuntimeState {
  modelPath: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llama: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any
}

let runtime: RuntimeState | null = null
let downloadAbort: AbortController | null = null
/** Serializes downloads so cancel + restart cannot interleave writes. */
let downloadGate: Promise<void> = Promise.resolve()
/** Serializes load/dispose so Stop + new chat cannot race Metal runtime. */
let runtimeGate: Promise<void> = Promise.resolve()

function enqueueRuntime<T>(fn: () => Promise<T>): Promise<T> {
  const run = runtimeGate.then(fn, fn)
  runtimeGate = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
const progressById = new Map<
  string,
  { downloaded: number; total: number; phase?: DownloadPhase }
>()
/** Active download id (survives Settings UI unmount). */
let activeDownloadId: string | null = null
const downloadErrorById = new Map<string, string>()

function verifiedSidecarPath(modelPath: string): string {
  return `${modelPath}.sha256`
}

function readVerifiedSidecar(modelPath: string): string | null {
  const side = verifiedSidecarPath(modelPath)
  if (!existsSync(side)) return null
  try {
    return readFileSync(side, 'utf8').trim().toLowerCase()
  } catch {
    return null
  }
}

function writeVerifiedSidecar(modelPath: string, sha256: string): void {
  writeFileSync(verifiedSidecarPath(modelPath), `${sha256}\n`, 'utf8')
}

function unlinkQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore
  }
}

/** Walk GGUF metadata with length caps — catches truncated/corrupt downloads. */
function ggufMetadataLooksSane(path: string): boolean {
  const fd = openSync(path, 'r')
  let pos = 0
  try {
    const fileSize = statSync(path).size
    const readExact = (n: number): Buffer => {
      if (n < 0 || pos + n > fileSize) throw new Error('eof')
      const buf = Buffer.alloc(n)
      const got = readSync(fd, buf, 0, n, pos)
      if (got !== n) throw new Error('short read')
      pos += n
      return buf
    }
    const u32 = () => readExact(4).readUInt32LE(0)
    const u64 = () => {
      const v = readExact(8).readBigUInt64LE(0)
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('u64 too large')
      return Number(v)
    }
    const skip = (n: number) => {
      if (n < 0 || pos + n > fileSize) throw new Error('skip past eof')
      pos += n
    }
    const skipString = () => {
      const n = u64()
      if (n > MAX_GGUF_STRING) throw new Error(`string length ${n}`)
      skip(n)
    }
    const skipValue = (type: number): void => {
      switch (type) {
        case 0:
        case 1:
        case 7:
          skip(1)
          return
        case 2:
        case 3:
          skip(2)
          return
        case 4:
        case 5:
        case 6:
          skip(4)
          return
        case 10:
        case 11:
        case 12:
          skip(8)
          return
        case 8:
          skipString()
          return
        case 9: {
          const elemType = u32()
          const count = u64()
          if (count > MAX_GGUF_ARRAY) throw new Error(`array length ${count}`)
          for (let i = 0; i < count; i++) skipValue(elemType)
          return
        }
        default:
          throw new Error(`bad type ${type}`)
      }
    }

    const magic = readExact(4).toString('utf8')
    if (magic !== 'GGUF') throw new Error('bad magic')
    const version = u32()
    if (version < 2 || version > 3) throw new Error(`bad version ${version}`)
    const tensorCount = u64()
    const kvCount = u64()
    if (tensorCount > 100_000 || kvCount > 10_000) throw new Error('insane header counts')
    for (let i = 0; i < kvCount; i++) {
      skipString()
      skipValue(u32())
    }
    for (let i = 0; i < Math.min(tensorCount, 8); i++) {
      skipString()
      const nDims = u32()
      if (nDims > 8) throw new Error('bad dims')
      for (let d = 0; d < nDims; d++) u64()
      u32() // type
      u64() // offset
    }
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('fs')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

function readManifest(): { builtinModels: BuiltinModelManifestEntry[] } {
  return JSON.parse(readFileSync(modelsManifestPath(), 'utf8')) as {
    builtinModels: BuiltinModelManifestEntry[]
  }
}

/** Prefer Lite as the default built-in Composer when present. */
export function getComposerManifest(): BuiltinModelManifestEntry {
  const manifest = readManifest()
  const composers = manifest.builtinModels.filter((m) => m.role === 'composer')
  const preferred =
    composers.find((m) => m.tier === 'lite' || m.id === 'composer-lite') ??
    composers.find((m) => m.id === 'composer') ??
    composers[0] ??
    manifest.builtinModels[0]
  if (!preferred) throw new Error('No built-in composer model in manifest')
  return preferred
}

export function findBuiltinEntry(idOrRef: string): BuiltinModelManifestEntry | null {
  const manifest = readManifest()
  const key = idOrRef.replace(/^builtin:/, '')
  return (
    manifest.builtinModels.find((m) => m.id === key || m.ref === idOrRef || m.ref === `builtin:${key}`) ??
    null
  )
}

export function localModelPath(entry: BuiltinModelManifestEntry): string {
  return join(builtinModelsDir(), entry.filename)
}

/** File looks like a complete GGUF of the expected size (not HTML / truncated / corrupt). */
export function isValidModelFile(path: string, entry: BuiltinModelManifestEntry): boolean {
  if (!existsSync(path)) return false
  try {
    const size = statSync(path).size
    const minBytes = Math.floor(entry.approxBytes * 0.98)
    const maxBytes = Math.ceil(entry.approxBytes * 1.02)
    if (size < minBytes || size > maxBytes) return false
    const fd = openSync(path, 'r')
    try {
      const magic = Buffer.alloc(4)
      readSync(fd, magic, 0, 4, 0)
      if (magic.toString('utf8') !== 'GGUF') return false
    } finally {
      closeSync(fd)
    }
    // Sidecar proves a prior checksum-verified download.
    if (entry.sha256) {
      const side = readVerifiedSidecar(path)
      if (side && side !== entry.sha256.toLowerCase()) return false
      if (side === entry.sha256.toLowerCase()) return true
    }
    // No sidecar yet (legacy install) or no known hash — validate GGUF structure.
    // This catches the corrupt Full download that still had the right byte size.
    return ggufMetadataLooksSane(path)
  } catch {
    return false
  }
}

export function getBuiltinStatuses(): BuiltinModelStatus[] {
  const manifest = readManifest()
  mkdirSync(builtinModelsDir(), { recursive: true })
  return manifest.builtinModels.map((entry) => {
    const path = localModelPath(entry)
    const installed = existsSync(path)
    const valid = installed && isValidModelFile(path, entry)
    const live = progressById.get(entry.id)
    const downloadedBytes = installed
      ? statSync(path).size
      : live?.downloaded ?? 0
    const total = live?.total || entry.approxBytes
    const phase = downloadingPhase(entry.id, live?.phase)
    let progress = total > 0 ? Math.min(1, downloadedBytes / total) : valid ? 1 : 0
    if (phase === 'verifying') progress = Math.max(progress, 0.96)
    if (phase === 'finalizing') progress = Math.max(progress, 0.99)
    const downloading = activeDownloadId === entry.id
    return {
      id: entry.id,
      ref: entry.ref,
      name: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      family: entry.family,
      parameters: entry.parameters,
      quant: entry.quant,
      filename: entry.filename,
      downloadUrl: entry.downloadUrl,
      approxBytes: entry.approxBytes,
      installed,
      ready: valid,
      localPath: installed ? path : null,
      downloadedBytes,
      progress: valid ? 1 : progress,
      tier: entry.tier,
      downloading,
      downloadPhase: downloading ? phase : null,
      downloadError: downloadErrorById.get(entry.id) || null
    }
  })
}

function downloadingPhase(
  id: string,
  phase?: DownloadPhase
): DownloadPhase | null {
  if (activeDownloadId !== id) return null
  return phase || 'downloading'
}

export function isBuiltinRef(model: string): boolean {
  return model.startsWith('builtin:')
}

/** Built-in Composer or user-downloaded local GGUF (runs via node-llama-cpp). */
export function isNativeGgufRef(model: string): boolean {
  return model.startsWith('builtin:') || model.startsWith('local:')
}

export async function ensureComposerDownloaded(
  onProgress?: (status: BuiltinModelStatus) => void,
  id?: string
): Promise<BuiltinModelStatus> {
  const entry = id ? findBuiltinEntry(id) ?? getComposerManifest() : getComposerManifest()
  const statuses = getBuiltinStatuses()
  const current = statuses.find((s) => s.id === entry.id)!
  if (current.ready) return current
  return downloadBuiltinModel(entry.id, onProgress)
}

/** True if the given builtin ref (or any composer) is ready to run. */
export function isBuiltinModelReady(modelRef: string): boolean {
  const statuses = getBuiltinStatuses()
  if (!isBuiltinRef(modelRef)) return false
  const entry = findBuiltinEntry(modelRef)
  if (entry) return Boolean(statuses.find((s) => s.id === entry.id)?.ready)
  return statuses.some((s) => s.ready)
}

/**
 * Exact-tier ready check — does not fall back to another builtin.
 * Use this for routing so Lite is never silently treated as Full (or vice versa).
 */
export function resolveExactBuiltinRef(preferred: string): string | null {
  if (!isBuiltinRef(preferred)) return null
  const statuses = getBuiltinStatuses()
  const entry = findBuiltinEntry(preferred)
  if (!entry) return null
  const status = statuses.find((s) => s.id === entry.id)
  return status?.ready ? entry.ref : null
}

/** True when this exact builtin ref is downloaded and valid. */
export function isExactBuiltinReady(preferred: string): boolean {
  return Boolean(resolveExactBuiltinRef(preferred))
}

/**
 * Pick a ready builtin when the requested one is missing (Lite ↔ Full).
 * Prefer {@link resolveExactBuiltinRef} for routing decisions.
 */
export function resolveReadyBuiltinRef(preferred: string): string | null {
  const exact = resolveExactBuiltinRef(preferred)
  if (exact) return exact
  const statuses = getBuiltinStatuses()
  const ready =
    statuses.find((s) => s.tier === 'lite' && s.ready) ??
    statuses.find((s) => s.ready)
  return ready?.ref ?? null
}

/** Recompute sha256, write sidecar on match, or remove corrupt file. */
export async function verifyBuiltinModel(id: string): Promise<{
  ok: boolean
  digest?: string
  expected?: string | null
  error?: string
}> {
  const entry = findBuiltinEntry(id)
  if (!entry) return { ok: false, error: 'Unknown model' }
  const path = localModelPath(entry)
  if (!existsSync(path)) return { ok: false, error: 'Model file not found' }
  if (!ggufMetadataLooksSane(path)) {
    unlinkQuiet(path)
    unlinkQuiet(verifiedSidecarPath(path))
    return { ok: false, error: 'Corrupt GGUF metadata — file removed. Re-download.' }
  }
  const digest = await sha256File(path)
  if (entry.sha256 && digest !== entry.sha256.toLowerCase()) {
    unlinkQuiet(path)
    unlinkQuiet(verifiedSidecarPath(path))
    return {
      ok: false,
      digest,
      expected: entry.sha256,
      error: 'Checksum mismatch — file removed. Re-download.'
    }
  }
  writeVerifiedSidecar(path, digest)
  return { ok: true, digest, expected: entry.sha256 }
}

export function deleteBuiltinModel(id: string): boolean {
  const entry = readManifest().builtinModels.find((m) => m.id === id)
  if (!entry) return false
  const target = localModelPath(entry)
  if (runtime?.modelPath === target) {
    void disposeRuntime()
  }
  unlinkQuiet(target)
  unlinkQuiet(verifiedSidecarPath(target))
  try {
    const dir = builtinModelsDir()
    const base = `${entry.filename}.partial.`
    for (const name of readdirSync(dir)) {
      if (name === `${entry.filename}.partial` || name.startsWith(base)) {
        unlinkQuiet(join(dir, name))
      }
    }
  } catch {
    // ignore
  }
  progressById.delete(id)
  logInfo('Builtin model deleted', { id })
  return true
}

export async function downloadBuiltinModel(
  id: string,
  onProgress?: (status: BuiltinModelStatus) => void
): Promise<BuiltinModelStatus> {
  const entry = readManifest().builtinModels.find((m) => m.id === id)
  if (!entry) throw new Error(`Unknown built-in model: ${id}`)

  mkdirSync(builtinModelsDir(), { recursive: true })
  const target = localModelPath(entry)
  if (isValidModelFile(target, entry)) {
    return getBuiltinStatuses().find((s) => s.id === id)!
  }

  // Cancel any in-flight download and wait so writers never interleave.
  downloadAbort?.abort()
  const previous = downloadGate
  let releaseGate!: () => void
  downloadGate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  await previous.catch(() => undefined)

  const controller = new AbortController()
  downloadAbort = controller
  activeDownloadId = id
  downloadErrorById.delete(id)
  const partial = `${target}.partial.${process.pid}.${Date.now()}`

  try {
    // Remove incomplete / corrupt installs before downloading again
    if (existsSync(target)) {
      logWarn('Removing invalid builtin model file before re-download', {
        id,
        size: statSync(target).size,
        expected: entry.approxBytes
      })
      unlinkQuiet(target)
      unlinkQuiet(verifiedSidecarPath(target))
    }

    let res
    try {
      res = await downloadFetch(entry.downloadUrl, { signal: controller.signal })
    } catch (err) {
      // Already formatted by downloadFetch / formatDownloadNetworkError
      if (err instanceof Error && /Could not reach|offline/i.test(err.message)) throw err
      throw formatDownloadNetworkError(err, entry.downloadUrl)
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `Download failed: HTTP ${res.status} from Hugging Face (${res.via}). ` +
          `Retry, or open the model URL in a browser to confirm huggingface.co is reachable.`
      )
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) {
      throw new Error(
        'Download failed: received HTML instead of a model file (blocked, login wall, or bad URL).'
      )
    }

    const resolved = resolveDownloadTotal(res.headers, entry.approxBytes)
    let total = resolved.total
    let downloaded = 0
    progressById.set(id, { downloaded, total, phase: 'downloading' })
    const emitProgress = createThrottledProgress(() => {
      if (!onProgress) return
      const status = getBuiltinStatuses().find((s) => s.id === id)
      if (status) onProgress(status)
    })
    emitProgress.flush()
    logInfo('Builtin model download streaming', {
      id,
      via: res.via,
      total,
      totalSource: resolved.source,
      urlHost: (() => {
        try {
          return new URL(entry.downloadUrl).host
        } catch {
          return 'unknown'
        }
      })()
    })

    const hasher = createHash('sha256')
    const nodeStream = bodyToNodeStream(res.body)
    const clearIdle = attachIdleTimeout(nodeStream, DOWNLOAD_IDLE_TIMEOUT_MS, (err) => {
      controller.abort()
      logWarn('Builtin model download idle timeout', { id, error: err.message })
    })
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hasher.update(chunk)
        downloaded += chunk.length
        if (total > 0 && downloaded > total) total = downloaded
        progressById.set(id, { downloaded, total, phase: 'downloading' })
        emitProgress.ping()
        cb(null, chunk)
      }
    })

    try {
      await pipeline(nodeStream, hashing, createWriteStream(partial))
    } finally {
      clearIdle()
    }

    // Bytes finished — bump total to actual size so the bar leaves ~90% when approx was high.
    total = Math.max(total, downloaded)
    progressById.set(id, { downloaded, total, phase: 'verifying' })
    emitProgress.flush()

    const minExpected = Math.floor(entry.approxBytes * 0.85)
    if (entry.approxBytes > 0 && downloaded < minExpected) {
      unlinkQuiet(partial)
      throw new Error(
        `Download incomplete (${formatApproxSize(downloaded)} of ~${formatApproxSize(entry.approxBytes)}). Try again.`
      )
    }

    const digest = hasher.digest('hex')
    if (entry.sha256 && digest !== entry.sha256.toLowerCase()) {
      unlinkQuiet(partial)
      throw new Error(
        `Download checksum mismatch for ${entry.displayName}. The file was corrupted in transit — try downloading again.`
      )
    }

    if (!ggufMetadataLooksSane(partial)) {
      unlinkQuiet(partial)
      throw new Error(
        `Download failed: ${entry.displayName} is not a valid GGUF model (corrupt metadata). Try again.`
      )
    }

    progressById.set(id, { downloaded, total, phase: 'finalizing' })
    emitProgress.flush()
    await publishDownloadedFile(partial, target)
    writeVerifiedSidecar(target, digest)
    progressById.set(id, { downloaded, total: downloaded, phase: 'finalizing' })
    emitProgress.flush()
    // Don't block the Settings UI on GPU runtime teardown.
    void disposeRuntime().catch((err) => {
      logWarn('disposeRuntime after builtin download failed', {
        id,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    logInfo('Builtin model download complete', { id, bytes: downloaded, sha256: digest })
    downloadErrorById.delete(id)
    const done = getBuiltinStatuses().find((s) => s.id === id)!
    if (onProgress) onProgress({ ...done, downloading: false, downloadPhase: null, progress: 1 })
    return done
  } catch (err) {
    unlinkQuiet(partial)
    const message = err instanceof Error ? err.message : String(err)
    if (!/abort/i.test(message)) {
      downloadErrorById.set(
        id,
        `${message} Tip: Retry, check VPN/firewall, or open the Hugging Face URL in a browser.`
      )
    }
    throw err
  } finally {
    if (downloadAbort === controller) downloadAbort = null
    if (activeDownloadId === id) activeDownloadId = null
    releaseGate()
  }
}

export function cancelBuiltinDownload(): void {
  downloadAbort?.abort()
}

async function loadLlamaModule(): Promise<LlamaModule> {
  return import('node-llama-cpp')
}

// --- utilityProcess isolation for node-llama-cpp ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llamaChild: any = null
let llamaChildReady: Promise<void> | null = null
let workerModelPath: string | null = null
let preferInProcess = false
let chatSeq = 0
/** Sessions known to exist in the llama worker (or in-process map). */
const activeChatSessions = new Set<string>()
/** In-process per-run sessions (worker path keeps its own map). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inProcessSessions = new Map<string, { session: any; sequence: any }>()

type WorkerMsg = {
  type: string
  id?: string
  requestId?: string
  sessionKey?: string
  text?: string
  error?: string
}

function workerScriptPath(): string {
  return join(__dirname, 'llama-worker.js')
}

function ensureLlamaChild(): Promise<void> {
  if (preferInProcess) return Promise.reject(new Error('in-process'))
  if (llamaChild && llamaChildReady) return llamaChildReady

  llamaChildReady = (async () => {
    // Lazy require so typecheck works without electron types in all contexts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utilityProcess } = require('electron') as {
      utilityProcess: {
        fork: (
          modulePath: string,
          args?: string[],
          opts?: { serviceName?: string; env?: NodeJS.ProcessEnv }
        ) => {
          on: (event: string, cb: (...args: unknown[]) => void) => void
          removeListener?: (event: string, cb: (...args: unknown[]) => void) => void
          postMessage: (msg: unknown) => void
          kill: () => void
          pid?: number
        }
      }
    }
    const script = workerScriptPath()
    if (!existsSync(script)) {
      preferInProcess = true
      throw new Error(`llama worker missing: ${script}`)
    }
    const preferEgpu =
      getResolvedSettings(appState.currentWorkspace).models.preferEgpu !== false
    const { env: gpuEnv } = await applyLlamaGpuPreference(preferEgpu)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      try {
        const child = utilityProcess.fork(script, [], {
          serviceName: 'eris-llama',
          env: { ...process.env, ...gpuEnv }
        })
        llamaChild = child
        const onReady = (raw: unknown) => {
          const msg = (raw && typeof raw === 'object' && 'data' in (raw as object)
            ? (raw as { data: WorkerMsg }).data
            : raw) as WorkerMsg
          if (msg?.type === 'ready') {
            try {
              child.removeListener?.('message', onReady)
            } catch {
              // ignore
            }
            settle()
          }
        }
        child.on('message', onReady)
        child.on('exit', () => {
          llamaChild = null
          llamaChildReady = null
          workerModelPath = null
        })
        setTimeout(() => {
          if (llamaChild === child) settle()
        }, 800)
      } catch (err) {
        preferInProcess = true
        llamaChild = null
        llamaChildReady = null
        settle(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })()

  return llamaChildReady
}

function postToWorker(msg: Record<string, unknown>): void {
  llamaChild?.postMessage(msg)
}

function onceWorkerMessage(
  predicate: (msg: WorkerMsg) => boolean,
  signal?: AbortSignal
): Promise<WorkerMsg> {
  return new Promise((resolve, reject) => {
    if (!llamaChild) {
      reject(new Error('No llama worker'))
      return
    }
    const onMsg = (raw: unknown) => {
      const msg = (raw && typeof raw === 'object' && 'data' in (raw as object)
        ? (raw as { data: WorkerMsg }).data
        : raw) as WorkerMsg
      if (!predicate(msg)) return
      cleanup()
      resolve(msg)
    }
    const onAbort = () => {
      cleanup()
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    const cleanup = () => {
      llamaChild?.off?.('message', onMsg)
      // electron UtilityProcess uses EventEmitter-style; also try removeListener
      try {
        llamaChild?.removeListener?.('message', onMsg)
      } catch {
        // ignore
      }
      signal?.removeEventListener('abort', onAbort)
    }
    llamaChild.on('message', onMsg)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort)
  })
}

function releaseInProcessSession(sessionKey: string): void {
  const entry = inProcessSessions.get(sessionKey)
  if (!entry) return
  inProcessSessions.delete(sessionKey)
  activeChatSessions.delete(sessionKey)
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

function releaseAllInProcessSessions(): void {
  for (const key of [...inProcessSessions.keys()]) releaseInProcessSession(key)
}

/** Drop a chat-run session (keeps the loaded GGUF). Safe to call if unknown. */
export function releaseLocalChatSession(sessionKey: string): void {
  if (!sessionKey) return
  activeChatSessions.delete(sessionKey)
  releaseInProcessSession(sessionKey)
  if (llamaChild) {
    try {
      postToWorker({ type: 'chat-release', sessionKey })
    } catch {
      // ignore
    }
  }
}

async function disposeRuntimeUnlocked(): Promise<void> {
  releaseAllInProcessSessions()
  activeChatSessions.clear()
  if (llamaChild) {
    try {
      postToWorker({ type: 'dispose' })
    } catch {
      // ignore
    }
    try {
      llamaChild.kill()
    } catch {
      // ignore
    }
    llamaChild = null
    llamaChildReady = null
    workerModelPath = null
  }
  if (!runtime) return
  try {
    await runtime.context?.dispose?.()
    await runtime.model?.dispose?.()
  } catch {
    // ignore
  }
  runtime = null
}

export async function disposeRuntime(): Promise<void> {
  return enqueueRuntime(() => disposeRuntimeUnlocked())
}

function contextPlan(entry: BuiltinModelManifestEntry): { min: number; max: number } {
  return contextLimits({
    tier: entry.tier,
    role: entry.role,
    modelContext: entry.contextWindow,
    settingsContext: getResolvedSettings(appState.currentWorkspace).models.contextWindow
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadModelForVram(llama: any, modelPath: string, contextMax: number): Promise<any> {
  try {
    return await llama.loadModel(modelLoadOptions(modelPath, contextMax, false))
  } catch (err) {
    if (!isMemoryError(err)) throw err
    logWarn('Model did not fit the target context; retrying with automatic GPU layers', {
      path: modelPath,
      error: err instanceof Error ? err.message : String(err)
    })
    return await llama.loadModel(modelLoadOptions(modelPath, contextMax, true))
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createContextForVram(model: any, plan: { min: number; max: number }): Promise<any> {
  try {
    return await model.createContext(contextCreateOptions(plan.min, plan.max, true))
  } catch (err) {
    logWarn('Quantized KV cache failed; retrying with the default cache', {
      error: err instanceof Error ? err.message : String(err)
    })
    return await model.createContext(contextCreateOptions(plan.min, plan.max, false))
  }
}

async function ensureRuntimeInProcess(
  modelPath: string,
  entry: BuiltinModelManifestEntry
): Promise<RuntimeState> {
  return enqueueRuntime(async () => {
    if (runtime?.modelPath === modelPath) return runtime
    await disposeRuntimeUnlocked()

    if (!isValidModelFile(modelPath, entry)) {
      throw new Error(
        `${entry.displayName} file is missing or corrupted. Open Settings → Models and download it again.`
      )
    }

    const llamaCpp = await loadLlamaModule()
    const { getLlama } = llamaCpp
    const preferEgpu =
      getResolvedSettings(appState.currentWorkspace).models.preferEgpu !== false
    const { status: gpuStatus } = await applyLlamaGpuPreference(preferEgpu)
    let llama
    try {
      llama = await getLlama({ gpu: 'auto', progressLogs: false })
    } catch (err) {
      logWarn('getLlama default failed, retrying GPU disabled', {
        error: err instanceof Error ? err.message : String(err)
      })
      llama = await getLlama({ gpu: false, progressLogs: false })
    }
    noteLlamaBackend(
      (llama.gpu === false ? false : llama.gpu) as LlamaGpuBackend,
      gpuStatus.backendDeviceName
    )

    const plan = contextPlan(entry)
    logInfo('Loading builtin model (in-process)', {
      path: modelPath,
      gpu: llama.gpu,
      egpu: gpuStatus.egpu?.name || null,
      preferEgpu,
      contextMin: plan.min,
      contextMax: plan.max
    })
    let model
    try {
      model = await loadModelForVram(llama, modelPath, plan.max)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('Failed to load builtin model', { path: modelPath, error: message })
      if (
        /Array buffer allocation failed|GGUF|parse|corrupt|out of range|ERR_OUT_OF_RANGE/i.test(
          message
        )
      ) {
        unlinkQuiet(verifiedSidecarPath(modelPath))
        try {
          if (!ggufMetadataLooksSane(modelPath)) unlinkQuiet(modelPath)
        } catch {
          // ignore
        }
        throw new Error(
          `${entry.displayName} file is corrupted. Open Settings → Models and download it again.`
        )
      }
      throw err
    }

    if (entry.sha256 && !readVerifiedSidecar(modelPath)) {
      void sha256File(modelPath)
        .then((digest) => {
          if (digest === entry.sha256!.toLowerCase()) writeVerifiedSidecar(modelPath, digest)
        })
        .catch(() => undefined)
    }

    const context = await createContextForVram(model, plan)
    runtime = { modelPath, llama, model, context }
    return runtime
  })
}

async function ensureWorkerModel(
  modelPath: string,
  entry: BuiltinModelManifestEntry
): Promise<void> {
  await ensureLlamaChild()
  if (workerModelPath === modelPath) return
  // Model swap drops all KV sessions in the worker.
  activeChatSessions.clear()
  releaseAllInProcessSessions()
  if (!isValidModelFile(modelPath, entry)) {
    throw new Error(
      `${entry.displayName} file is missing or corrupted. Open Settings → Models and download it again.`
    )
  }
  const requestId = `load-${Date.now()}`
  const plan = contextPlan(entry)
  const preferEgpu =
    getResolvedSettings(appState.currentWorkspace).models.preferEgpu !== false
  const { status: gpuStatus } = await applyLlamaGpuPreference(preferEgpu)
  logInfo('Loading builtin model (utilityProcess)', {
    path: modelPath,
    egpu: gpuStatus.egpu?.name || null,
    preferEgpu,
    backend: gpuStatus.backend,
    contextMin: plan.min,
    contextMax: plan.max
  })
  postToWorker({
    type: 'load',
    modelPath,
    contextSize: plan.max,
    contextMin: plan.min,
    requestId,
    preferEgpu,
    gpu: 'auto'
  })
  const result = await onceWorkerMessage(
    (m) =>
      (m.type === 'loaded' || m.type === 'load-error') && m.requestId === requestId
  )
  if (result.type === 'load-error') {
    throw new Error(result.error || 'Failed to load model in worker')
  }
  workerModelPath = modelPath
}

async function* streamBuiltinChatInProcess(options: {
  modelRef: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  signal?: AbortSignal
  entry: BuiltinModelManifestEntry
  path: string
  jsonSchema?: Record<string, unknown>
  sessionKey?: string
}): AsyncGenerator<string, void, unknown> {
  const llamaCpp = await loadLlamaModule()
  const { LlamaChatSession } = llamaCpp
  const state = await ensureRuntimeInProcess(options.path, options.entry)
  const maxTokens = REPLY_MAX_TOKENS

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let grammar: any = undefined
  if (options.jsonSchema) {
    try {
      grammar = await state.llama.createGrammarForJsonSchema(options.jsonSchema)
    } catch {
      grammar = undefined
    }
  }

  const split = options.sessionKey ? splitSessionPrompt(options.messages) : null

  if (options.sessionKey && split) {
    const key = options.sessionKey
    let entry = inProcessSessions.get(key)
    if (!entry || entry.session.disposed) {
      const system =
        split.seed
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n') || undefined
      const sequence = state.context.getSequence()
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: system,
        autoDisposeSequence: false
      })
      entry = { session, sequence }
      inProcessSessions.set(key, entry)
      activeChatSessions.add(key)
      if (split.seed.length) {
        try {
          // node-llama-cpp ChatHistoryItem — keep loosely typed across versions.
          session.setChatHistory(messagesToLlamaHistory(split.seed) as never)
        } catch {
          // optional
        }
      }
    }

    const queue: string[] = []
    let done = false
    let caughtError: unknown = null
    let notify: (() => void) | null = null
    const wait = () =>
      new Promise<void>((resolve) => {
        notify = resolve
      })
    const wake = () => {
      notify?.()
      notify = null
    }
    const onAbortWake = () => {
      done = true
      wake()
    }
    options.signal?.addEventListener('abort', onAbortWake)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptOpts: any = {
      temperature: options.temperature,
      signal: options.signal,
      maxTokens,
      stopOnAbortSignal: true,
      ...(grammar ? { grammar } : {}),
      onTextChunk(chunk: string) {
        queue.push(chunk)
        wake()
      }
    }
    const run = entry.session
      .prompt(split.userMessage, promptOpts)
      .then(() => {
        done = true
        wake()
      })
      .catch((err: unknown) => {
        caughtError = err
        done = true
        wake()
      })
    try {
      while (!done || queue.length > 0) {
        if (options.signal?.aborted) {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          throw err
        }
        if (queue.length === 0) await wait()
        while (queue.length > 0) yield queue.shift() as string
      }
      await run
      if (options.signal?.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      if (caughtError) {
        const message =
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        const name = caughtError instanceof Error ? caughtError.name : ''
        if (name === 'AbortError' || /abort/i.test(message)) {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          throw err
        }
        throw caughtError instanceof Error ? caughtError : new Error(message)
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbortWake)
    }
    return
  }

  // Oneshot path — dispose sequence after the turn.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sequence: any = null
  try {
    sequence = state.context.getSequence()
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

    const queue: string[] = []
    let done = false
    let caughtError: unknown = null
    let notify: (() => void) | null = null
    const wait = () =>
      new Promise<void>((resolve) => {
        notify = resolve
      })
    const wake = () => {
      notify?.()
      notify = null
    }
    const onAbortWake = () => {
      done = true
      wake()
    }
    options.signal?.addEventListener('abort', onAbortWake)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inProcPromptOpts: any = {
      temperature: options.temperature,
      signal: options.signal,
      maxTokens,
      ...(grammar ? { grammar } : {}),
      onTextChunk(chunk: string) {
        queue.push(chunk)
        wake()
      }
    }
    const run = session
      .prompt(prompt, inProcPromptOpts)
      .then(() => {
        done = true
        wake()
      })
      .catch((err: unknown) => {
        caughtError = err
        done = true
        wake()
      })
    try {
      while (!done || queue.length > 0) {
        if (options.signal?.aborted) {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          throw err
        }
        if (queue.length === 0) await wait()
        while (queue.length > 0) yield queue.shift() as string
      }
      await run
      if (options.signal?.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      if (caughtError) {
        const message =
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        const name = caughtError instanceof Error ? caughtError.name : ''
        if (name === 'AbortError' || /abort/i.test(message)) {
          const err = new Error('Aborted')
          err.name = 'AbortError'
          throw err
        }
        throw caughtError instanceof Error ? caughtError : new Error(message)
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbortWake)
    }
  } finally {
    try {
      await sequence?.dispose?.()
    } catch {
      // ignore
    }
  }
}

async function* streamBuiltinChatViaWorker(options: {
  modelRef: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  signal?: AbortSignal
  entry: BuiltinModelManifestEntry
  path: string
  jsonSchema?: Record<string, unknown>
  sessionKey?: string
}): AsyncGenerator<string, void, unknown> {
  await ensureWorkerModel(options.path, options.entry)

  const id = `chat-${++chatSeq}`
  const queue: string[] = []
  let done = false
  let caughtError: string | null = null
  let notify: (() => void) | null = null

  const wait = () =>
    new Promise<void>((resolve) => {
      notify = resolve
    })
  const wake = () => {
    notify?.()
    notify = null
  }

  const onMsg = (raw: unknown) => {
    const msg = (raw && typeof raw === 'object' && 'data' in (raw as object)
      ? (raw as { data: WorkerMsg }).data
      : raw) as WorkerMsg
    if (msg.id !== id) return
    if (msg.type === 'chunk' && msg.text) {
      queue.push(msg.text)
      wake()
    } else if (msg.type === 'done') {
      if (options.sessionKey) activeChatSessions.add(options.sessionKey)
      done = true
      wake()
    } else if (msg.type === 'error') {
      caughtError = msg.error || 'Worker error'
      done = true
      wake()
    }
  }

  llamaChild.on('message', onMsg)
  const onAbort = () => {
    postToWorker({ type: 'abort', id })
    done = true
    wake()
  }
  options.signal?.addEventListener('abort', onAbort)

  const split = options.sessionKey ? splitSessionPrompt(options.messages) : null
  if (options.sessionKey && split) {
    const isNew = !activeChatSessions.has(options.sessionKey)
    postToWorker({
      type: 'chat-turn',
      id,
      sessionKey: options.sessionKey,
      userMessage: split.userMessage,
      seedMessages: isNew ? split.seed : undefined,
      temperature: options.temperature,
      maxTokens: REPLY_MAX_TOKENS,
      jsonSchema: options.jsonSchema
    })
  } else {
    postToWorker({
      type: 'chat',
      id,
      messages: options.messages,
      temperature: options.temperature,
      maxTokens: REPLY_MAX_TOKENS,
      jsonSchema: options.jsonSchema
    })
  }

  try {
    while (!done || queue.length > 0) {
      if (options.signal?.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      if (queue.length === 0) await wait()
      while (queue.length > 0) {
        yield queue.shift() as string
      }
    }
    if (options.signal?.aborted || caughtError === 'Aborted') {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    if (caughtError) throw new Error(caughtError)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    try {
      llamaChild?.removeListener?.('message', onMsg)
      llamaChild?.off?.('message', onMsg)
    } catch {
      // ignore
    }
  }
}

type WarmResult = { ok: boolean; model?: string; error?: string }
let warmInFlight: { modelRef: string; promise: Promise<WarmResult> } | null = null

/**
 * Background-load a selected or default ready GGUF so the next local chat turn
 * does not pay the cold fork + model-load cost.
 */
export function warmLocalInference(
  settings?: AppSettings,
  requestedModel?: string
): Promise<WarmResult> {
  if (process.env.VITEST || process.env.ERIS_SKIP_LLAMA_WARM === '1') {
    return Promise.resolve({ ok: false, error: 'skipped' })
  }
  const s = settings ?? getResolvedSettings(appState.currentWorkspace)
  const preferred = requestedModel || s.models.defaultModel || 'builtin:composer-lite'
  if (warmInFlight?.modelRef === preferred) return warmInFlight.promise

  const previousWarm = warmInFlight?.promise.catch(() => undefined)
  const promise = (async () => {
    try {
      await previousWarm
      let entry: BuiltinModelManifestEntry | null = null
      let path = ''

      if (preferred.startsWith('local:')) {
        const { findLocalEntry, localModelFilePath, localEntryAsBuiltin, isLocalModelReady } =
          await import('./local-model')
        if (isLocalModelReady(preferred)) {
          const local = findLocalEntry(preferred)
          if (local) {
            entry = localEntryAsBuiltin(local)
            path = localModelFilePath(local)
          }
        }
      } else if (preferred.startsWith('builtin:') && resolveExactBuiltinRef(preferred)) {
        entry = findBuiltinEntry(preferred)
        if (entry) path = localModelPath(entry)
      }

      if ((!entry || !path) && !requestedModel) {
        const ready = getBuiltinStatuses().find((b) => b.ready)
        if (ready) {
          entry = findBuiltinEntry(ready.id)
          if (entry) path = localModelPath(entry)
        }
      }

      if (!entry || !path) {
        return {
          ok: false,
          error: requestedModel ? `Local model ${requestedModel} is not ready` : 'no ready local model'
        }
      }

      await ensureWorkerModel(path, entry)
      logInfo('Warmed local inference', { model: entry.ref })
      return { ok: true, model: entry.ref }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logWarn('Local inference warm failed', { error: message })
      return { ok: false, error: message }
    }
  })()
  const active = { modelRef: preferred, promise }
  warmInFlight = active
  void promise.then(
    () => {
      if (warmInFlight === active) warmInFlight = null
    },
    () => {
      if (warmInFlight === active) warmInFlight = null
    }
  )
  return promise
}

export async function* streamBuiltinChat(options: {
  modelRef: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature: number
  signal?: AbortSignal
  /** Constrain decoding to this JSON schema via a GBNF grammar (tool-call retries). */
  jsonSchema?: Record<string, unknown>
  /**
   * When set, reuse a LlamaChatSession / KV cache across agent steps.
   * Pass the same key for the whole chat run; call releaseLocalChatSession when done.
   */
  sessionKey?: string
}): AsyncGenerator<string, void, unknown> {
  let entry: BuiltinModelManifestEntry
  let path: string

  if (options.modelRef.startsWith('local:')) {
    const { findLocalEntry, localModelFilePath, localEntryAsBuiltin } = await import('./local-model')
    const local = findLocalEntry(options.modelRef)
    if (!local) {
      throw new Error(`Unknown local model “${options.modelRef}”. Open Settings → Models.`)
    }
    entry = localEntryAsBuiltin(local)
    path = localModelFilePath(local)
    if (!existsSync(path)) {
      throw new Error(
        `${entry.displayName} is not installed yet. Open Settings → Models → Local and download it (~${formatApproxSize(entry.approxBytes)}).`
      )
    }
  } else {
    entry = findBuiltinEntry(options.modelRef) ?? getComposerManifest()
    path = localModelPath(entry)
    if (!existsSync(path)) {
      throw new Error(
        `${entry.displayName} is not installed yet. Open Settings → Models and download it (~${formatApproxSize(entry.approxBytes)}).`
      )
    }
    if (!isValidModelFile(path, entry)) {
      throw new Error(
        `${entry.displayName} file looks incomplete or corrupted. Open Settings → Models and download it again.`
      )
    }
  }

  // Prefer utilityProcess so Metal/CPU inference does not freeze the Electron UI.
  // Fall back to in-process on worker failures (including sequence races).
  if (!preferInProcess) {
    try {
      yield* streamBuiltinChatViaWorker({ ...options, entry, path })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const name = err instanceof Error ? err.name : ''
      if (name === 'AbortError' || /abort/i.test(message)) throw err
      logWarn('llama utilityProcess failed; falling back in-process', { error: message })
      // Kill broken worker so the next attempt can retry isolation later
      try {
        await disposeRuntime()
      } catch {
        // ignore
      }
      // One hard failure (missing worker) → stick to in-process for the session
      if (/worker missing|in-process/i.test(message)) preferInProcess = true
    }
  }

  yield* streamBuiltinChatInProcess({ ...options, entry, path })
}
