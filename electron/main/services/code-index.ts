import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { workspaceConfigDir } from './paths'
import { logInfo } from './logger'
import { suppressWatcherFor } from './workspace-watcher'
import { hashEmbed } from './hash-embeddings'
import {
  HASH_EMBEDDING_SPACE,
  sameEmbeddingSpace,
  type EmbeddingSpace
} from '../../../src/shared/embedding-space'
import { workspaceRequest } from './workspace-worker-client'
import { shouldSkipDir, shouldSkipWorkspacePath } from './workspace-ignore'

export type SymbolHit = {
  name: string
  kind: string
  path: string
  line: number
}

export type SymbolRef = {
  name: string
  path: string
  line: number
}

type FileMeta = { mtimeMs: number; size: number }

export type IndexRecord = {
  updatedAt: number
  workspacePath: string
  symbols: SymbolHit[]
  files: string[]
  refs?: SymbolRef[]
  embeddingSpace?: EmbeddingSpace
  embeddings?: Record<string, number[]>
  /** Per-file mtimes for incremental patching. */
  fileMeta?: Record<string, FileMeta>
}

let memoryIndex: IndexRecord | null = null
const workerBuilds = new Map<string, Promise<IndexRecord>>()
const indexLoads = new Map<string, Promise<IndexRecord | null>>()
const patches = new Map<string, Promise<void>>()
const pendingPatches = new Map<string, Set<string>>()

const SYMBOL_RES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'function', re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/g },
  { kind: 'class', re: /(?:export\s+)?class\s+([A-Za-z_][\w]*)/g },
  { kind: 'type', re: /(?:export\s+)?(?:type|interface)\s+([A-Za-z_][\w]*)/g },
  { kind: 'const', re: /(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*=/g }
]

const FRESH_MS = 5 * 60_000

function indexPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'code-index.json')
}

function walk(root: string, dir: string, files: string[], maxFiles: number): void {
  if (files.length >= maxFiles) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (files.length >= maxFiles) return
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    const rel = relative(root, full).split(sep).join('/')
    if (st.isDirectory()) {
      if (shouldSkipDir(root, name, rel)) continue
      walk(root, full, files, maxFiles)
    } else if (
      /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|php|phtml|sql)$/i.test(name) &&
      st.size < 800_000 &&
      !shouldSkipWorkspacePath(root, rel, false)
    ) {
      files.push(full)
    }
  }
}

function extractRegexSymbols(rel: string, content: string): SymbolHit[] {
  const symbols: SymbolHit[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const { kind, re } of SYMBOL_RES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        symbols.push({ name: m[1]!, kind, path: rel, line: i + 1 })
        if (symbols.length > 400) break
      }
    }
  }
  return symbols
}

function persistIndex(workspacePath: string, record: IndexRecord): IndexRecord {
  memoryIndex = record
  try {
    mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
    suppressWatcherFor(indexPath(workspacePath))
    writeFileSync(indexPath(workspacePath), JSON.stringify(record), 'utf8')
  } catch {
    // ignore persist errors
  }
  logInfo('Code index built', { files: record.files.length, symbols: record.symbols.length })
  return record
}

function collectFileMeta(workspacePath: string, abs: string, rel: string): FileMeta | null {
  try {
    const st = statSync(abs)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    void workspacePath
    void rel
    return null
  }
}

export function buildCodeIndex(workspacePath: string): IndexRecord {
  const filesAbs: string[] = []
  walk(workspacePath, workspacePath, filesAbs, 8000)
  const symbols: SymbolHit[] = []
  const files: string[] = []
  const refs: SymbolRef[] = []
  const embeddings: Record<string, number[]> = {}
  const fileMeta: Record<string, FileMeta> = {}
  for (const abs of filesAbs) {
    const rel = relative(workspacePath, abs).split(sep).join('/')
    files.push(rel)
    const meta = collectFileMeta(workspacePath, abs, rel)
    if (meta) fileMeta[rel] = meta
    let content = ''
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const extracted = extractRegexSymbols(rel, content)
    symbols.push(...extracted)
    embeddings[rel] = hashEmbed(`${rel}\n${content.slice(0, 6000)}`)
  }
  return persistIndex(workspacePath, {
    updatedAt: Date.now(),
    workspacePath,
    symbols,
    files,
    refs,
    embeddingSpace: HASH_EMBEDDING_SPACE,
    embeddings,
    fileMeta
  })
}

/** Cooperative rebuild — yields every N files so IPC/UI stay responsive. */
export async function buildCodeIndexAsync(workspacePath: string): Promise<IndexRecord> {
  const pending = workerBuilds.get(workspacePath)
  if (pending) return pending
  suppressWatcherFor(indexPath(workspacePath), 180_000)
  const job = workspaceRequest({
    type: 'index',
    root: workspacePath,
    indexPath: indexPath(workspacePath)
  })
    .then((record) => {
      memoryIndex = record
      return record
    })
    .finally(() => workerBuilds.delete(workspacePath))
  workerBuilds.set(workspacePath, job)
  return job
}

/**
 * Patch only the given relative paths into the existing index (incremental).
 * Falls back to a full async rebuild when there is no base index.
 */
export async function patchCodeIndexFiles(
  workspacePath: string,
  relPaths: string[]
): Promise<IndexRecord> {
  // Apply changes after any older full snapshot has finished, so it cannot
  // overwrite newer incremental edits when the worker replies.
  if (workerBuilds.has(workspacePath)) await workerBuilds.get(workspacePath)
  const record = await workspaceRequest({
    type: 'patch-index',
    root: workspacePath,
    indexPath: indexPath(workspacePath),
    paths: relPaths
  })
  memoryIndex = record
  return record
}

export function loadCodeIndex(workspacePath: string): IndexRecord | null {
  if (memoryIndex?.workspacePath === workspacePath) {
    if (sameEmbeddingSpace(memoryIndex.embeddingSpace, HASH_EMBEDDING_SPACE)) return memoryIndex
    scheduleBackgroundRebuild(workspacePath)
    return { ...memoryIndex, embeddings: undefined }
  }
  void ensureCodeIndexAsync(workspacePath).catch(() => undefined)
  return null
}

function scheduleBackgroundRebuild(workspacePath: string): void {
  void buildCodeIndexAsync(workspacePath).catch(() => undefined)
}

/**
 * Call when the workspace tree may have changed (FS watcher / agent writes).
 * Pass relative paths for incremental patching; omit for a full background rebuild.
 */
export function notifyWorkspaceFilesChanged(workspacePath: string, changedRels?: string[]): void {
  if (!changedRels || changedRels.length === 0) {
    scheduleBackgroundRebuild(workspacePath)
    return
  }
  const pending = pendingPatches.get(workspacePath) ?? new Set<string>()
  pendingPatches.set(workspacePath, pending)
  for (const rel of changedRels) pending.add(rel.split('\\').join('/'))
  if (patches.has(workspacePath)) return
  const run = async (): Promise<void> => {
    while (pending.size > 0) {
      const batch = [...pending]
      pending.clear()
      // Large batches → full rebuild is cheaper than N sequential patches.
      if (batch.length > 80) {
        await buildCodeIndexAsync(workspacePath)
      } else {
        await patchCodeIndexFiles(workspacePath, batch)
      }
    }
  }
  const job = run()
    .catch(() => undefined)
    .finally(() => {
      patches.delete(workspacePath)
      if (pending.size) notifyWorkspaceFilesChanged(workspacePath, [...pending])
      else pendingPatches.delete(workspacePath)
    })
  patches.set(workspacePath, job)
}

/**
 * Synchronous consumers use memory and schedule background loading/building.
 * Interactive requests never build or parse a disk index on the main thread.
 */
export function ensureCodeIndex(workspacePath: string): IndexRecord {
  const existing = loadCodeIndex(workspacePath)
  if (existing) {
    const age = Date.now() - existing.updatedAt
    if (age >= FRESH_MS) {
      scheduleBackgroundRebuild(workspacePath)
    }
    return existing
  }
  return { workspacePath, updatedAt: 0, files: [], symbols: [] }
}

export async function ensureCodeIndexAsync(workspacePath: string): Promise<IndexRecord | null> {
  let existing = memoryIndex?.workspacePath === workspacePath ? memoryIndex : null
  if (!existing) {
    let loading = indexLoads.get(workspacePath)
    if (!loading) {
      loading = workspaceRequest({
        type: 'load-index',
        indexPath: indexPath(workspacePath)
      }).finally(() => indexLoads.delete(workspacePath))
      indexLoads.set(workspacePath, loading)
    }
    existing = await loading
    if (existing?.workspacePath === workspacePath) {
      if (
        memoryIndex?.workspacePath === workspacePath &&
        memoryIndex.updatedAt > existing.updatedAt
      )
        existing = memoryIndex
      else memoryIndex = existing
    } else existing = null
  }
  if (existing) {
    if (!sameEmbeddingSpace(existing.embeddingSpace, HASH_EMBEDDING_SPACE)) {
      scheduleBackgroundRebuild(workspacePath)
      return { ...existing, embeddings: undefined }
    }
    if (Date.now() - existing.updatedAt >= FRESH_MS) scheduleBackgroundRebuild(workspacePath)
    return existing
  }
  // A cold index is built off the interactive path. Retrieval can use ripgrep
  // candidates for this request and the next request will see the new index.
  scheduleBackgroundRebuild(workspacePath)
  return null
}

async function readyIndex(workspacePath: string): Promise<IndexRecord> {
  return (await ensureCodeIndexAsync(workspacePath)) ?? buildCodeIndexAsync(workspacePath)
}

export async function findSymbols(
  workspacePath: string,
  query: string,
  max = 30
): Promise<{ ok: boolean; detail: string; hits: SymbolHit[] }> {
  const index = await readyIndex(workspacePath)
  const q = query.trim().toLowerCase()
  if (!q) {
    return {
      ok: true,
      detail: `Index: ${index.files.length} files, ${index.symbols.length} symbols`,
      hits: []
    }
  }
  const hits = index.symbols
    .filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
    .slice(0, max)
  const detail =
    hits.length === 0
      ? `No symbols matching “${query}”`
      : hits.map((h) => `${h.kind} ${h.name} — ${h.path}:${h.line}`).join('\n')
  return { ok: true, detail, hits }
}

export async function findReferences(
  workspacePath: string,
  name: string,
  max = 40
): Promise<{ ok: boolean; detail: string; hits: SymbolRef[] }> {
  const index = await readyIndex(workspacePath)
  const q = name.trim()
  if (!q) return { ok: false, detail: 'name is required', hits: [] }
  const defs = index.symbols.filter((s) => s.name === q)
  const refs = (index.refs ?? []).filter((r) => r.name === q)
  const hits = [...defs.map((d) => ({ name: d.name, path: d.path, line: d.line })), ...refs].slice(
    0,
    max
  )
  const detail =
    hits.length === 0
      ? `No references to ${q}`
      : hits.map((h) => `${h.path}:${h.line} ${h.name}`).join('\n')
  return { ok: true, detail, hits }
}

export async function relatedFiles(
  workspacePath: string,
  path: string,
  max = 8
): Promise<{ ok: boolean; detail: string; paths: string[] }> {
  const index = await readyIndex(workspacePath)
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const names = new Set(
    index.symbols.filter((s) => s.path === rel || s.path.endsWith('/' + rel)).map((s) => s.name)
  )
  if (names.size === 0) {
    return { ok: true, detail: `No symbols in ${path}`, paths: [] }
  }
  const counts = new Map<string, number>()
  for (const s of index.symbols) {
    if (s.path === rel) continue
    if (names.has(s.name)) counts.set(s.path, (counts.get(s.path) ?? 0) + 3)
  }
  for (const r of index.refs ?? []) {
    if (r.path === rel) continue
    if (names.has(r.name)) counts.set(r.path, (counts.get(r.path) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max)
  const paths = ranked.map(([p]) => p)
  return {
    ok: true,
    detail: paths.length ? paths.map((p) => `- ${p}`).join('\n') : 'No related files',
    paths
  }
}

export function fileEmbedding(workspacePath: string, rel: string): number[] | null {
  return loadCodeIndex(workspacePath)?.embeddings?.[rel] ?? null
}

export function formatIndexSummary(workspacePath: string): string {
  try {
    const cached = loadCodeIndex(workspacePath)
    if (cached) {
      if (Date.now() - cached.updatedAt >= FRESH_MS) {
        scheduleBackgroundRebuild(workspacePath)
      }
      return `Code index: ${cached.files.length} source files, ${cached.symbols.length} symbols (cached).`
    }
    // Cold start: light note + background build (avoid blocking agent prompt assembly)
    void ensureCodeIndexAsync(workspacePath).catch(() => undefined)
    return 'Code index: building in background…'
  } catch {
    return ''
  }
}
