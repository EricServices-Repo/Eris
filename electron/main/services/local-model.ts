/**
 * User-installed local GGUFs — download and run inside Eris via node-llama-cpp.
 * No Ollama daemon required.
 */
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import type {
  BuiltinModelManifestEntry,
  LocalModelManifestEntry,
  LocalModelStatus
} from '../../../src/shared/settings-schema'
import { localModelsDir, modelsManifestPath } from './paths'
import { logError, logInfo, logWarn } from './logger'
import {
  attachIdleTimeout,
  bodyToNodeStream,
  createThrottledProgress,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  downloadFetch,
  findResumablePartial,
  formatDownloadNetworkError,
  hashFileInto,
  peekPartialBytes,
  publishDownloadedFile,
  resolveResumeDownloadTotal,
  stablePartialPath,
  type DownloadPhase
} from './http-download'
import {
  parseHfGgufFileUrl,
  resolveHfGgufFile,
  type HfGgufFile
} from './hf-gguf'

function formatApproxSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${bytes} B`
}

let downloadAbort: AbortController | null = null
let downloadGate: Promise<void> = Promise.resolve()
let activeDownloadId: string | null = null
const progressById = new Map<
  string,
  { downloaded: number; total: number; phase?: DownloadPhase }
>()
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
    /* ignore */
  }
}

function readManifest(): { localModels?: LocalModelManifestEntry[] } {
  return JSON.parse(readFileSync(modelsManifestPath(), 'utf8')) as {
    localModels?: LocalModelManifestEntry[]
  }
}

function extrasCatalogPath(): string {
  return join(localModelsDir(), 'catalog-extra.json')
}

function readExtrasCatalog(): LocalModelManifestEntry[] {
  const path = extrasCatalogPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      localModels?: LocalModelManifestEntry[]
    }
    return Array.isArray(raw.localModels) ? raw.localModels : []
  } catch {
    return []
  }
}

function writeExtrasCatalog(entries: LocalModelManifestEntry[]): void {
  mkdirSync(localModelsDir(), { recursive: true })
  writeFileSync(
    extrasCatalogPath(),
    `${JSON.stringify({ version: 1, localModels: entries }, null, 2)}\n`,
    'utf8'
  )
}

function upsertExtraEntry(entry: LocalModelManifestEntry): void {
  const extras = readExtrasCatalog().filter((e) => e.id !== entry.id && e.ref !== entry.ref)
  extras.push(entry)
  writeExtrasCatalog(extras)
}

function removeExtraEntry(id: string): void {
  const next = readExtrasCatalog().filter((e) => e.id !== id)
  writeExtrasCatalog(next)
}

export function listLocalCatalog(): LocalModelManifestEntry[] {
  const builtIn = readManifest().localModels ?? []
  const extras = readExtrasCatalog()
  const seen = new Set(builtIn.map((m) => m.id))
  const merged = [...builtIn]
  for (const e of extras) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    merged.push(e)
  }
  return merged
}

function formatSizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `~${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `~${Math.round(bytes / 1e6)} MB`
  return formatApproxSize(bytes)
}

function slugFromRepo(repoId: string, filename: string): string {
  const leaf = (repoId.split('/').pop() || repoId)
    .replace(/-?GGUF$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  const quant = (filename.match(/[-_](q\d[_a-z0-9]+|iq\d[_a-z0-9]+)\.gguf$/i)?.[1] || 'gguf')
    .toLowerCase()
    .replace(/_/g, '')
  const base = `hf-${leaf}-${quant}`.slice(0, 80)
  return base.replace(/-+$/g, '')
}

export function entryFromHfFile(
  file: HfGgufFile,
  fit?: { budgetBytes: number; fits: boolean }
): LocalModelManifestEntry {
  const id = slugFromRepo(file.repoId, file.filename)
  const name = (file.repoId.split('/').pop() || file.repoId)
    .replace(/-?GGUF$/i, '')
    .replace(/_/g, ' ')
  const approxBytes = file.sizeBytes > 0 ? file.sizeBytes : 1
  return {
    id,
    ref: `local:${id}`,
    name,
    displayName: `${name} (local)`,
    description: describeHfDownload(file, fit),
    family: 'Hugging Face',
    quant: file.quant,
    parameters: '?',
    contextWindow: 32768,
    filename: file.filename,
    downloadUrl: file.downloadUrl,
    approxBytes,
    sha256: null,
    sizeLabel: file.sizeBytes > 0 ? formatSizeLabel(file.sizeBytes) : 'size unknown'
  }
}

function emitLocalProgress(
  id: string,
  onProgress?: (status: LocalModelStatus) => void
): void {
  if (!onProgress) return
  const status = getLocalStatuses().find((s) => s.id === id)
  if (status) onProgress(status)
}

async function currentInferenceBudgetBytes(): Promise<number> {
  const { getResolvedSettings } = await import('./settings')
  const { appState } = await import('../app-state')
  const { getGpuAccelStatus } = await import('./gpu-accel')
  const { inferenceBudgetBytes } = await import('./vram-fit')
  const prefer =
    getResolvedSettings(appState.currentWorkspace).models.preferEgpu !== false
  const gpu = await getGpuAccelStatus(prefer)
  return inferenceBudgetBytes({
    vramShareFreeBytes: gpu.vramShareFreeBytes,
    vramShareTotalBytes: gpu.vramShareTotalBytes,
    preferredFreeBytes: gpu.preferredGpu?.vramFreeBytes,
    preferredTotalBytes: gpu.preferredGpu?.vramBytes
  })
}

/** Register (or reuse) a Hub GGUF in the local catalog, then download it. */
export async function downloadLocalFromHf(
  repoIdOrUrl: string,
  onProgress?: (status: LocalModelStatus) => void,
  options?: { filename?: string }
): Promise<LocalModelStatus> {
  const direct = parseHfGgufFileUrl(repoIdOrUrl)
  const budgetBytes = direct
    ? 0
    : await currentInferenceBudgetBytes()
  const file = await resolveHfGgufFile(repoIdOrUrl, {
    filename: options?.filename || direct?.filename,
    budgetBytes
  })
  const existing = listLocalCatalog().find(
    (m) =>
      m.downloadUrl === file.downloadUrl ||
      (m.filename === file.filename && m.downloadUrl.includes(file.repoId))
  )
  const entry =
    existing ??
    entryFromHfFile(file, {
      budgetBytes,
      fits: file.fits !== false
    })
  if (!existing) upsertExtraEntry(entry)
  // Surface the new catalog row in Settings immediately (before the byte stream).
  if (onProgress) {
    const preview = getLocalStatuses().find((s) => s.id === entry.id)
    if (preview) {
      onProgress({
        ...preview,
        downloading: true,
        downloadPhase: 'downloading',
        progress: preview.progress || 0
      })
    }
  }
  return downloadLocalModel(entry.id, onProgress)
}

export function isLocalRef(model: string): boolean {
  return model.startsWith('local:')
}

export function findLocalEntry(idOrRef: string): LocalModelManifestEntry | null {
  const key = idOrRef.replace(/^local:/, '')
  return (
    listLocalCatalog().find(
      (m) => m.id === key || m.ref === idOrRef || m.ref === `local:${key}`
    ) ?? null
  )
}

export function localModelFilePath(entry: LocalModelManifestEntry): string {
  return join(localModelsDir(), entry.filename)
}

/** Adapt a local catalog entry for the shared GGUF chat runtime. */
export function localEntryAsBuiltin(entry: LocalModelManifestEntry): BuiltinModelManifestEntry {
  return {
    id: entry.id,
    ref: entry.ref,
    name: entry.name,
    displayName: entry.displayName,
    description: entry.description,
    family: entry.family,
    quant: entry.quant,
    parameters: entry.parameters,
    contextWindow: entry.contextWindow,
    filename: entry.filename,
    downloadUrl: entry.downloadUrl,
    approxBytes: entry.approxBytes,
    sha256: entry.sha256,
    role: 'local',
    tier: 'full'
  }
}

function describeHfDownload(
  file: HfGgufFile,
  fit?: { budgetBytes: number; fits: boolean }
): string {
  const from = `Downloaded from Hugging Face (${file.repoId}).`
  if (!fit || fit.budgetBytes <= 0 || file.sizeBytes <= 0) {
    return `${from} Runs inside Eris.`
  }
  const fileSize = formatApproxSize(file.sizeBytes)
  const free = formatApproxSize(fit.budgetBytes)
  if (fit.fits) {
    return `${from} ${file.quant} selected — this model needs ${fileSize} and ${free} is free.`
  }
  return `${from} ${file.quant} selected — this model needs ${fileSize} and ${free} is free, so extra layers stay on CPU.`
}

function isValidLocalFile(path: string, entry: LocalModelManifestEntry): boolean {
  if (!existsSync(path)) return false
  try {
    const size = statSync(path).size
    const minBytes = Math.floor(entry.approxBytes * 0.9)
    const maxBytes = Math.ceil(entry.approxBytes * 1.15)
    if (size < minBytes || size > maxBytes) return false
    const fd = openSync(path, 'r')
    try {
      const magic = Buffer.alloc(4)
      readSync(fd, magic, 0, 4, 0)
      if (magic.toString('utf8') !== 'GGUF') return false
    } finally {
      closeSync(fd)
    }
    if (entry.sha256) {
      const side = readVerifiedSidecar(path)
      if (side && side !== entry.sha256.toLowerCase()) return false
      if (side === entry.sha256.toLowerCase()) return true
    }
    return true
  } catch {
    return false
  }
}

export function getLocalStatuses(): LocalModelStatus[] {
  mkdirSync(localModelsDir(), { recursive: true })
  return listLocalCatalog().map((entry) => {
    const path = localModelFilePath(entry)
    const installed = existsSync(path)
    const valid = installed && isValidLocalFile(path, entry)
    const live = progressById.get(entry.id)
    const pausedBytes = !installed && !live ? peekPartialBytes(path) : 0
    const downloadedBytes = installed
      ? statSync(path).size
      : live?.downloaded ?? pausedBytes
    const total = live?.total || entry.approxBytes
    const downloading = activeDownloadId === entry.id
    const phase =
      downloading ? live?.phase || 'downloading' : null
    let progress = total > 0 ? Math.min(1, downloadedBytes / total) : valid ? 1 : 0
    if (phase === 'verifying') progress = Math.max(progress, 0.96)
    if (phase === 'finalizing') progress = Math.max(progress, 0.99)
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
      sizeLabel: entry.sizeLabel,
      installed,
      ready: valid,
      localPath: installed ? path : null,
      downloadedBytes,
      progress: valid ? 1 : progress,
      downloading,
      downloadPhase: phase,
      downloadError: downloadErrorById.get(entry.id) || null
    }
  })
}

export function resolveExactLocalRef(preferred: string): string | null {
  if (!isLocalRef(preferred) && !findLocalEntry(preferred)) return null
  const entry = findLocalEntry(preferred)
  if (!entry) return null
  const status = getLocalStatuses().find((s) => s.id === entry.id)
  return status?.ready ? entry.ref : null
}

export function isLocalModelReady(modelRef: string): boolean {
  return Boolean(resolveExactLocalRef(modelRef))
}

export function cancelLocalDownload(): void {
  downloadAbort?.abort()
}

export function deleteLocalModel(id: string): LocalModelStatus | null {
  const entry = findLocalEntry(id)
  if (!entry) return null
  const path = localModelFilePath(entry)
  unlinkQuiet(path)
  unlinkQuiet(verifiedSidecarPath(path))
  unlinkQuiet(stablePartialPath(path))
  // Clean legacy pid/timestamp partials.
  try {
    const dir = localModelsDir()
    const base = `${entry.filename}.partial.`
    for (const name of readdirSync(dir)) {
      if (name === `${entry.filename}.partial` || name.startsWith(base)) {
        unlinkQuiet(join(dir, name))
      }
    }
  } catch {
    // ignore
  }
  progressById.delete(entry.id)
  downloadErrorById.delete(entry.id)
  // Drop Hub-added catalog rows once the file is gone (curated manifest stays).
  if (entry.id.startsWith('hf-') || entry.family === 'Hugging Face') {
    removeExtraEntry(entry.id)
    return null
  }
  return getLocalStatuses().find((s) => s.id === entry.id) ?? null
}

export async function downloadLocalModel(
  id: string,
  onProgress?: (status: LocalModelStatus) => void
): Promise<LocalModelStatus> {
  const entry = findLocalEntry(id)
  if (!entry) throw new Error(`Unknown local model: ${id}`)

  const target = localModelFilePath(entry)
  mkdirSync(localModelsDir(), { recursive: true })

  if (isValidLocalFile(target, entry)) {
    return getLocalStatuses().find((s) => s.id === entry.id)!
  }

  let releaseGate: () => void = () => undefined
  const previous = downloadGate
  downloadGate = new Promise<void>((resolve) => {
    releaseGate = () => resolve()
  })
  await previous.catch(() => undefined)

  const controller = new AbortController()
  downloadAbort = controller
  activeDownloadId = entry.id
  downloadErrorById.delete(entry.id)
  const earlyPartial = findResumablePartial(target)
  progressById.set(entry.id, {
    downloaded: earlyPartial?.size ?? progressById.get(entry.id)?.downloaded ?? 0,
    total: entry.approxBytes > 0 ? entry.approxBytes : progressById.get(entry.id)?.total ?? 0,
    phase: 'downloading'
  })
  // Immediate UI update so Settings lists the row as downloading before the first byte.
  emitLocalProgress(entry.id, onProgress)
  const partial = stablePartialPath(target)

  try {
    if (existsSync(target)) {
      logWarn('Removing invalid local model before re-download', {
        id: entry.id,
        size: statSync(target).size
      })
      unlinkQuiet(target)
      unlinkQuiet(verifiedSidecarPath(target))
    }

    // Resume from a previous cancel/stall when possible.
    let existing = 0
    const found = findResumablePartial(target)
    if (found) {
      if (found.path !== partial) {
        try {
          renameSync(found.path, partial)
        } catch {
          // use found.path below via size only — prefer stable path
        }
      }
      existing = found.size
      // Tiny leftovers are usually a failed HTML/error page — start clean.
      if (existing > 0 && existing < 1024 * 1024) {
        unlinkQuiet(partial)
        existing = 0
      }
    }

    const reqHeaders: Record<string, string> = {}
    if (existing > 0) reqHeaders.Range = `bytes=${existing}-`

    let res
    try {
      res = await downloadFetch(entry.downloadUrl, {
        signal: controller.signal,
        headers: reqHeaders
      })
    } catch (err) {
      if (err instanceof Error && /Could not reach|offline/i.test(err.message)) throw err
      throw formatDownloadNetworkError(err, entry.downloadUrl)
    }

    // 416 = server thinks we already have the whole file — verify what's on disk.
    if (existing > 0 && res.status === 416) {
      logInfo('Local model Range 416 — verifying existing partial', {
        id: entry.id,
        existing
      })
    } else if (existing > 0 && res.status === 200) {
      // Server ignored Range — restart from byte 0.
      logWarn('Local model server ignored Range; restarting download', {
        id: entry.id,
        existing
      })
      unlinkQuiet(partial)
      existing = 0
    } else if (!(res.ok || res.status === 206) || (!res.body && res.status !== 416)) {
      throw new Error(
        `Download failed: HTTP ${res.status} (${res.via}). Retry, or open the model URL in a browser.`
      )
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (res.body && contentType.includes('text/html')) {
      unlinkQuiet(partial)
      throw new Error(
        'Download failed: received HTML instead of a model file (blocked or bad URL).'
      )
    }

    const resolved = resolveResumeDownloadTotal(
      res.headers,
      entry.approxBytes,
      existing,
      res.status
    )
    let total = resolved.total
    let downloaded = existing
    progressById.set(entry.id, { downloaded, total, phase: 'downloading' })
    const emitProgress = createThrottledProgress(() => {
      if (!onProgress) return
      const status = getLocalStatuses().find((s) => s.id === entry.id)
      if (status) onProgress(status)
    })
    emitProgress.flush()
    logInfo('Local model download streaming', {
      id: entry.id,
      via: res.via,
      total,
      totalSource: resolved.source,
      resumeFrom: existing,
      status: res.status
    })

    const hasher = createHash('sha256')
    if (existing > 0 && existsSync(partial)) {
      await hashFileInto(hasher, partial)
    }

    if (res.body && (res.status === 200 || res.status === 206)) {
      const nodeStream = bodyToNodeStream(res.body)
      const clearIdle = attachIdleTimeout(nodeStream, DOWNLOAD_IDLE_TIMEOUT_MS, (err) => {
        controller.abort()
        logWarn('Local model download idle timeout', { id: entry.id, error: err.message })
      })
      const hashing = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hasher.update(chunk)
          downloaded += chunk.length
          if (total > 0 && downloaded > total) total = downloaded
          progressById.set(entry.id, { downloaded, total, phase: 'downloading' })
          emitProgress.ping()
          cb(null, chunk)
        }
      })
      const append = existing > 0 && res.status === 206
      try {
        await pipeline(
          nodeStream,
          hashing,
          createWriteStream(partial, { flags: append ? 'a' : 'w' })
        )
      } finally {
        clearIdle()
      }
    }

    if (!existsSync(partial)) {
      throw new Error('Download produced no file')
    }
    downloaded = statSync(partial).size

    total = Math.max(total, downloaded)
    progressById.set(entry.id, { downloaded, total, phase: 'verifying' })
    emitProgress.flush()

    const minExpected = Math.floor(entry.approxBytes * 0.85)
    if (entry.approxBytes > 0 && downloaded < minExpected) {
      // Keep partial so Retry can Range-resume.
      throw new Error(
        `Download incomplete (${formatApproxSize(downloaded)} of ~${formatApproxSize(entry.approxBytes)}). Retry to resume.`
      )
    }

    const digest = hasher.digest('hex')
    if (entry.sha256 && digest !== entry.sha256.toLowerCase()) {
      unlinkQuiet(partial)
      throw new Error('Download checksum mismatch — file may be corrupt. Try again.')
    }

    progressById.set(entry.id, { downloaded, total, phase: 'finalizing' })
    emitProgress.flush()
    await publishDownloadedFile(partial, target)
    writeVerifiedSidecar(target, digest)

    progressById.set(entry.id, { downloaded, total: downloaded, phase: 'finalizing' })
    emitProgress.flush()
    downloadErrorById.delete(entry.id)
    logInfo('Local model download complete', {
      id: entry.id,
      bytes: downloaded,
      resumed: existing > 0
    })
    const done = getLocalStatuses().find((s) => s.id === entry.id)!
    if (onProgress) onProgress({ ...done, downloading: false, downloadPhase: null, progress: 1 })
    return done
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const discard =
      /checksum|HTML instead|corrupt|not a valid/i.test(message)
    if (discard) unlinkQuiet(partial)
    // Abort / stall / network: keep .partial so the next attempt resumes.
    if (!/abort/i.test(message)) {
      downloadErrorById.set(
        entry.id,
        `${message} Tip: Retry resumes from where it left off when possible.`
      )
      logError('Local model download failed', { id: entry.id, error: message })
    } else {
      logInfo('Local model download canceled — partial kept for resume', {
        id: entry.id,
        partialBytes: existsSync(partial) ? statSync(partial).size : 0
      })
    }
    throw err
  } finally {
    if (downloadAbort === controller) downloadAbort = null
    if (activeDownloadId === entry.id) activeDownloadId = null
    releaseGate()
  }
}
