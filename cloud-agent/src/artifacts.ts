import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative } from 'path'
import { config } from './config.js'
import { assertInWorkspace, jobWorkspace } from './workspace.js'

export interface ArtifactFile {
  path: string
  /** Final content after the cloud job */
  content: string
  /** Seeded / previous content when known (null = new file) */
  before: string | null
}

export interface JobArtifacts {
  jobId: string
  createdAt: string
  files: ArtifactFile[]
  /** True when the pack hit size/file caps */
  truncated: boolean
  truncatedReasons?: string[]
  totalBytes: number
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.eris-cloud', 'dist', 'out', 'coverage'])

function artifactsDir(): string {
  return join(config.dataDir, 'artifacts')
}

function artifactsPath(jobId: string): string {
  return join(artifactsDir(), `${jobId}.json`)
}

function seedPath(jobId: string): string {
  return join(artifactsDir(), `${jobId}.seed.json`)
}

/** Persist the seeded workspace overlay so we can compute before/after on finish. */
export function saveSeedBaseline(
  jobId: string,
  files: Array<{ path: string; content: string }>
): void {
  mkdirSync(artifactsDir(), { recursive: true })
  const map: Record<string, string> = {}
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!p || p.includes('..')) continue
    map[p] = f.content
  }
  writeFileSync(seedPath(jobId), JSON.stringify({ jobId, files: map }, null, 2), 'utf8')
}

function loadSeedBaseline(jobId: string): Record<string, string> {
  try {
    if (!existsSync(seedPath(jobId))) return {}
    const raw = JSON.parse(readFileSync(seedPath(jobId), 'utf8')) as {
      files?: Record<string, string>
    }
    return raw.files || {}
  } catch {
    return {}
  }
}

/**
 * Merge current workspace contents into the seed baseline for paths not already recorded.
 * Call before write_file so before/after diffs work for git-cloned files.
 */
export function snapshotWorkspaceBaseline(jobId: string, relPaths: string[]): void {
  const workspace = jobWorkspace(jobId)
  const existing = loadSeedBaseline(jobId)
  let changed = false
  for (const rel of relPaths) {
    const path = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.includes('..') || Object.prototype.hasOwnProperty.call(existing, path)) {
      continue
    }
    try {
      const abs = assertInWorkspace(workspace, path)
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        // New file — mark as null via empty sentinel; before stays null in pack
        continue
      }
      const st = statSync(abs)
      if (st.size > config.maxFileBytes) continue
      const buf = readFileSync(abs)
      if (buf.includes(0)) continue
      existing[path] = buf.toString('utf8')
      changed = true
    } catch {
      // skip
    }
  }
  if (changed) {
    mkdirSync(artifactsDir(), { recursive: true })
    writeFileSync(seedPath(jobId), JSON.stringify({ jobId, files: existing }, null, 2), 'utf8')
  }
}

function isProbablyText(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  let bad = 0
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) {
    const c = buf[i]!
    if (c === 9 || c === 10 || c === 13) continue
    if (c < 32 || c === 127) bad++
  }
  return bad / Math.max(1, n) < 0.02
}

/**
 * Build a patch bundle from filesTouched (preferred) plus any seed diffs.
 * Caps files/bytes for safe transfer back to Eris.
 */
export function buildJobArtifacts(jobId: string, filesTouched: string[]): JobArtifacts {
  const workspace = jobWorkspace(jobId)
  const seed = loadSeedBaseline(jobId)
  const maxFiles = Math.min(config.maxFiles, 120)
  const maxBytes = config.maxArtifactBytes
  const files: ArtifactFile[] = []
  const truncatedReasons: string[] = []
  let totalBytes = 0
  let truncated = false
  const seen = new Set<string>()

  const markTruncated = (reason: string) => {
    truncated = true
    if (!truncatedReasons.includes(reason)) truncatedReasons.push(reason)
  }

  const consider = (relPath: string) => {
    const path = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.includes('..') || seen.has(path)) return
    seen.add(path)
    if (files.length >= maxFiles || totalBytes >= maxBytes) {
      markTruncated(files.length >= maxFiles ? 'max_files' : 'max_bytes')
      return
    }
    let abs: string
    try {
      abs = assertInWorkspace(workspace, path)
    } catch {
      return
    }
    if (!existsSync(abs)) return
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (!st.isFile() || st.size > config.maxFileBytes) {
      if (st.isFile() && st.size > config.maxFileBytes) markTruncated('file_too_large')
      return
    }
    let buf: Buffer
    try {
      buf = readFileSync(abs)
    } catch {
      return
    }
    if (!isProbablyText(buf)) return
    const content = buf.toString('utf8')
    const before = Object.prototype.hasOwnProperty.call(seed, path) ? seed[path]! : null
    if (before !== null && before === content) return
    if (before === null && content === '' && !filesTouched.includes(path)) return

    const size = Buffer.byteLength(content, 'utf8')
    if (totalBytes + size > maxBytes) {
      markTruncated('max_bytes')
      return
    }
    files.push({ path, content, before })
    totalBytes += size
  }

  for (const p of filesTouched) consider(p)

  if (files.length < maxFiles && existsSync(workspace)) {
    const walk = (dir: string, depth: number) => {
      if (truncated || files.length >= maxFiles || depth > 10) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        const abs = join(dir, name)
        let st
        try {
          st = lstatSync(abs)
          if (st.isSymbolicLink()) continue
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(abs, depth + 1)
          continue
        }
        if (!st.isFile()) continue
        const rel = relative(workspace, abs).replace(/\\/g, '/')
        if (!seen.has(rel)) consider(rel)
        if (truncated || files.length >= maxFiles) return
      }
    }
    walk(workspace, 0)
  }

  const pack: JobArtifacts = {
    jobId,
    createdAt: new Date().toISOString(),
    files,
    truncated,
    truncatedReasons: truncatedReasons.length ? truncatedReasons : undefined,
    totalBytes
  }
  mkdirSync(dirname(artifactsPath(jobId)), { recursive: true })
  writeFileSync(artifactsPath(jobId), JSON.stringify(pack), 'utf8')
  return pack
}

export function readJobArtifacts(jobId: string): JobArtifacts | null {
  const path = artifactsPath(jobId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JobArtifacts
  } catch {
    return null
  }
}

export function artifactsSummary(jobId: string): {
  hasArtifacts: boolean
  artifactCount: number
  truncated?: boolean
} {
  const pack = readJobArtifacts(jobId)
  if (!pack) return { hasArtifacts: false, artifactCount: 0 }
  return {
    hasArtifacts: pack.files.length > 0,
    artifactCount: pack.files.length,
    truncated: pack.truncated
  }
}
