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
  bodyToNodeStream,
  downloadFetch,
  formatDownloadNetworkError
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
const progressById = new Map<string, { downloaded: number; total: number }>()
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

export function entryFromHfFile(file: HfGgufFile): LocalModelManifestEntry {
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
    description: `Downloaded from Hugging Face (${file.repoId}) — runs inside Eris.`,
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

/** Register (or reuse) a Hub GGUF in the local catalog, then download it. */
export async function downloadLocalFromHf(
  repoIdOrUrl: string,
  onProgress?: (status: LocalModelStatus) => void,
  options?: { filename?: string }
): Promise<LocalModelStatus> {
  const direct = parseHfGgufFileUrl(repoIdOrUrl)
  const file = await resolveHfGgufFile(repoIdOrUrl, {
    filename: options?.filename || direct?.filename
  })
  const existing = listLocalCatalog().find(
    (m) =>
      m.downloadUrl === file.downloadUrl ||
      (m.filename === file.filename && m.downloadUrl.includes(file.repoId))
  )
  const entry = existing ?? entryFromHfFile(file)
  if (!existing) upsertExtraEntry(entry)
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
    tier: 'lite'
  }
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
    const downloadedBytes = installed
      ? statSync(path).size
      : progressById.get(entry.id)?.downloaded ?? 0
    const total = progressById.get(entry.id)?.total || entry.approxBytes
    const progress = total > 0 ? Math.min(1, downloadedBytes / total) : valid ? 1 : 0
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
      downloading: activeDownloadId === entry.id,
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
  const partial = `${target}.partial.${process.pid}.${Date.now()}`

  try {
    if (existsSync(target)) {
      logWarn('Removing invalid local model before re-download', {
        id: entry.id,
        size: statSync(target).size
      })
      unlinkQuiet(target)
      unlinkQuiet(verifiedSidecarPath(target))
    }

    let res
    try {
      res = await downloadFetch(entry.downloadUrl, { signal: controller.signal })
    } catch (err) {
      if (err instanceof Error && /Could not reach|offline/i.test(err.message)) throw err
      throw formatDownloadNetworkError(err, entry.downloadUrl)
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `Download failed: HTTP ${res.status} (${res.via}). Retry, or open the model URL in a browser.`
      )
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) {
      throw new Error(
        'Download failed: received HTML instead of a model file (blocked or bad URL).'
      )
    }

    const total = Number(
      res.headers.get('content-length') ||
        res.headers.get('x-linked-size') ||
        entry.approxBytes
    )
    let downloaded = 0
    progressById.set(entry.id, { downloaded, total })
    logInfo('Local model download streaming', {
      id: entry.id,
      via: res.via,
      total
    })

    const hasher = createHash('sha256')
    const nodeStream = bodyToNodeStream(res.body)
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hasher.update(chunk)
        downloaded += chunk.length
        progressById.set(entry.id, { downloaded, total })
        if (onProgress) {
          const status = getLocalStatuses().find((s) => s.id === entry.id)
          if (status) onProgress(status)
        }
        cb(null, chunk)
      }
    })

    await pipeline(nodeStream, hashing, createWriteStream(partial))

    if (downloaded < Math.floor(entry.approxBytes * 0.9)) {
      unlinkQuiet(partial)
      throw new Error(
        `Download incomplete (${formatApproxSize(downloaded)} of ~${formatApproxSize(entry.approxBytes)}). Try again.`
      )
    }

    const digest = hasher.digest('hex')
    renameSync(partial, target)
    if (entry.sha256) {
      if (digest !== entry.sha256.toLowerCase()) {
        unlinkQuiet(target)
        throw new Error('Download checksum mismatch — file may be corrupt. Try again.')
      }
      writeVerifiedSidecar(target, digest)
    } else {
      writeVerifiedSidecar(target, digest)
    }

    progressById.set(entry.id, { downloaded, total: downloaded })
    downloadErrorById.delete(entry.id)
    logInfo('Local model download complete', { id: entry.id, bytes: downloaded })
    return getLocalStatuses().find((s) => s.id === entry.id)!
  } catch (err) {
    unlinkQuiet(partial)
    const message = err instanceof Error ? err.message : String(err)
    if (!/abort/i.test(message)) {
      downloadErrorById.set(
        entry.id,
        `${message} Tip: Retry, check VPN/firewall, or open the download URL in a browser.`
      )
      logError('Local model download failed', { id: entry.id, error: message })
    }
    throw err
  } finally {
    if (downloadAbort === controller) downloadAbort = null
    if (activeDownloadId === entry.id) activeDownloadId = null
    releaseGate()
  }
}
