import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { workspaceConfigDir } from './paths'
import { logInfo } from './logger'
import { suppressWatcherFor } from './workspace-watcher'
import { hashEmbed } from './embeddings'
import { parseSymbolsAndRefs, treeSitterSupported } from './symbol-parse'
import {
  invalidateWorkspaceIgnoreCache,
  shouldSkipDir,
  shouldSkipWorkspacePath
} from './workspace-ignore'

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

type IndexRecord = {
  updatedAt: number
  workspacePath: string
  symbols: SymbolHit[]
  files: string[]
  refs?: SymbolRef[]
  embeddings?: Record<string, number[]>
  /** Per-file mtimes for incremental patching. */
  fileMeta?: Record<string, FileMeta>
}

let memoryIndex: IndexRecord | null = null
let rebuildInFlight: Promise<IndexRecord> | null = null
let patchInFlight: Promise<IndexRecord> | null = null
const pendingPatchRels = new Set<string>()

const SYMBOL_RES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'function', re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/g },
  { kind: 'class', re: /(?:export\s+)?class\s+([A-Za-z_][\w]*)/g },
  { kind: 'type', re: /(?:export\s+)?(?:type|interface)\s+([A-Za-z_][\w]*)/g },
  { kind: 'const', re: /(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*=/g }
]

const FRESH_MS = 5 * 60_000
const STALE_OK_MS = 30 * 60_000

function indexPath(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'code-index.json')
}

function yieldEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r))
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
      /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(name) &&
      st.size < 800_000 &&
      !shouldSkipWorkspacePath(root, rel, false)
    ) {
      files.push(full)
    }
  }
}

async function walkAsync(
  root: string,
  dir: string,
  files: string[],
  maxFiles: number,
  progress: { entries: number }
): Promise<void> {
  if (files.length >= maxFiles) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (files.length >= maxFiles) return
    progress.entries++
    if (progress.entries % 100 === 0) await yieldEventLoop()
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
      await walkAsync(root, full, files, maxFiles, progress)
    } else if (
      /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(name) &&
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

async function indexFile(
  workspacePath: string,
  abs: string
): Promise<{ rel: string; symbols: SymbolHit[]; refs: SymbolRef[]; embedding: number[] }> {
  const rel = relative(workspacePath, abs).split(sep).join('/')
  let content = ''
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    return { rel, symbols: [], refs: [], embedding: [] }
  }
  let symbols: SymbolHit[] = []
  let refs: SymbolRef[] = []
  if (treeSitterSupported(abs)) {
    try {
      const parsed = await parseSymbolsAndRefs(abs, rel, content)
      symbols = parsed.symbols
      refs = parsed.refs.slice(0, 800)
    } catch {
      symbols = []
    }
  }
  if (symbols.length === 0) symbols = extractRegexSymbols(rel, content)
  return { rel, symbols, refs, embedding: hashEmbed(`${rel}\n${content.slice(0, 6000)}`) }
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
    embeddings,
    fileMeta
  })
}

/** Cooperative rebuild — yields every N files so IPC/UI stay responsive. */
export async function buildCodeIndexAsync(workspacePath: string): Promise<IndexRecord> {
  const filesAbs: string[] = []
  await walkAsync(workspacePath, workspacePath, filesAbs, 8000, { entries: 0 })
  const symbols: SymbolHit[] = []
  const files: string[] = []
  const refs: SymbolRef[] = []
  const embeddings: Record<string, number[]> = {}
  const fileMeta: Record<string, FileMeta> = {}
  for (let fi = 0; fi < filesAbs.length; fi++) {
    if (fi > 0 && fi % 20 === 0) await yieldEventLoop()
    const abs = filesAbs[fi]!
    const parsed = await indexFile(workspacePath, abs)
    files.push(parsed.rel)
    symbols.push(...parsed.symbols)
    refs.push(...parsed.refs)
    if (parsed.embedding.length) embeddings[parsed.rel] = parsed.embedding
    const meta = collectFileMeta(workspacePath, abs, parsed.rel)
    if (meta) fileMeta[parsed.rel] = meta
    if (symbols.length > 40_000) break
  }
  const record = persistIndex(workspacePath, {
    updatedAt: Date.now(),
    workspacePath,
    symbols,
    files,
    refs: refs.slice(0, 120_000),
    embeddings,
    fileMeta
  })
  logInfo('Code index built (async)', { files: files.length, symbols: symbols.length, refs: refs.length })
  return record
}

const INDEXABLE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i

/**
 * Patch only the given relative paths into the existing index (incremental).
 * Falls back to a full async rebuild when there is no base index.
 */
export async function patchCodeIndexFiles(
  workspacePath: string,
  relPaths: string[]
): Promise<IndexRecord> {
  const unique = [
    ...new Set(
      relPaths
        .map((p) => p.split('\\').join('/').replace(/^\.\//, ''))
        .filter(Boolean)
    )
  ]
  if (unique.some((p) => p === '.gitignore' || p === '.erisignore' || p.endsWith('/.gitignore'))) {
    invalidateWorkspaceIgnoreCache(workspacePath)
  }

  let base = loadCodeIndex(workspacePath)
  if (!base || base.workspacePath !== workspacePath) {
    return buildCodeIndexAsync(workspacePath)
  }

  const symbols = base.symbols.filter((s) => !unique.includes(s.path))
  const refs = (base.refs ?? []).filter((r) => !unique.includes(r.path))
  const embeddings = { ...(base.embeddings ?? {}) }
  const fileMeta = { ...(base.fileMeta ?? {}) }
  const fileSet = new Set(base.files)

  for (const rel of unique) {
    delete embeddings[rel]
    delete fileMeta[rel]
    fileSet.delete(rel)
    if (shouldSkipWorkspacePath(workspacePath, rel, false)) continue
    if (!INDEXABLE_RE.test(rel)) continue
    const abs = join(workspacePath, ...rel.split('/'))
    if (!existsSync(abs)) continue
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (!st.isFile() || st.size >= 800_000) continue
    const parsed = await indexFile(workspacePath, abs)
    fileSet.add(parsed.rel)
    symbols.push(...parsed.symbols)
    refs.push(...parsed.refs)
    if (parsed.embedding.length) embeddings[parsed.rel] = parsed.embedding
    fileMeta[parsed.rel] = { mtimeMs: st.mtimeMs, size: st.size }
  }

  const record = persistIndex(workspacePath, {
    updatedAt: Date.now(),
    workspacePath,
    symbols: symbols.slice(0, 40_000),
    files: [...fileSet],
    refs: refs.slice(0, 120_000),
    embeddings,
    fileMeta
  })
  logInfo('Code index patched', { patched: unique.length, files: record.files.length })
  return record
}

export function loadCodeIndex(workspacePath: string): IndexRecord | null {
  if (memoryIndex?.workspacePath === workspacePath) return memoryIndex
  const path = indexPath(workspacePath)
  if (!existsSync(path)) return null
  try {
    memoryIndex = JSON.parse(readFileSync(path, 'utf8')) as IndexRecord
    return memoryIndex
  } catch {
    return null
  }
}

function scheduleBackgroundRebuild(workspacePath: string): void {
  if (rebuildInFlight) return
  // Start after the current IPC turn; buildCodeIndexAsync walks the workspace
  // synchronously before its first cooperative yield.
  rebuildInFlight = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => buildCodeIndexAsync(workspacePath))
    .catch(() => memoryIndex as IndexRecord)
    .finally(() => {
      rebuildInFlight = null
    })
}

/**
 * Call when the workspace tree may have changed (FS watcher / agent writes).
 * Pass relative paths for incremental patching; omit for a full background rebuild.
 */
export function notifyWorkspaceFilesChanged(
  workspacePath: string,
  changedRels?: string[]
): void {
  if (!changedRels || changedRels.length === 0) {
    scheduleBackgroundRebuild(workspacePath)
    return
  }
  for (const rel of changedRels) pendingPatchRels.add(rel.split('\\').join('/'))
  if (patchInFlight) return
  const run = async (): Promise<IndexRecord> => {
    while (pendingPatchRels.size > 0) {
      const batch = [...pendingPatchRels]
      pendingPatchRels.clear()
      // Large batches → full rebuild is cheaper than N sequential patches.
      if (batch.length > 80) {
        return buildCodeIndexAsync(workspacePath)
      }
      await patchCodeIndexFiles(workspacePath, batch)
    }
    return loadCodeIndex(workspacePath) || buildCodeIndex(workspacePath)
  }
  patchInFlight = run()
    .catch(() => memoryIndex as IndexRecord)
    .finally(() => {
      patchInFlight = null
      if (pendingPatchRels.size > 0) {
        notifyWorkspaceFilesChanged(workspacePath, [...pendingPatchRels])
      }
    })
}

/**
 * Prefer disk/memory cache; only block on a cold index.
 * Stale indexes return immediately and refresh in the background.
 */
export function ensureCodeIndex(workspacePath: string): IndexRecord {
  const existing = loadCodeIndex(workspacePath)
  if (existing) {
    const age = Date.now() - existing.updatedAt
    if (age >= FRESH_MS && age < STALE_OK_MS) {
      scheduleBackgroundRebuild(workspacePath)
    } else if (age >= STALE_OK_MS) {
      scheduleBackgroundRebuild(workspacePath)
    }
    return existing
  }
  return buildCodeIndex(workspacePath)
}

export async function ensureCodeIndexAsync(workspacePath: string): Promise<IndexRecord | null> {
  const existing = loadCodeIndex(workspacePath)
  if (existing) {
    if (Date.now() - existing.updatedAt >= FRESH_MS) scheduleBackgroundRebuild(workspacePath)
    return existing
  }
  // A cold index is built off the interactive path. Retrieval can use ripgrep
  // candidates for this request and the next request will see the new index.
  scheduleBackgroundRebuild(workspacePath)
  return null
}

export function findSymbols(
  workspacePath: string,
  query: string,
  max = 30
): { ok: boolean; detail: string; hits: SymbolHit[] } {
  const index = ensureCodeIndex(workspacePath)
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

export function findReferences(
  workspacePath: string,
  name: string,
  max = 40
): { ok: boolean; detail: string; hits: SymbolRef[] } {
  const index = ensureCodeIndex(workspacePath)
  const q = name.trim()
  if (!q) return { ok: false, detail: 'name is required', hits: [] }
  const defs = index.symbols.filter((s) => s.name === q)
  const refs = (index.refs ?? []).filter((r) => r.name === q)
  const hits = [
    ...defs.map((d) => ({ name: d.name, path: d.path, line: d.line })),
    ...refs
  ].slice(0, max)
  const detail =
    hits.length === 0
      ? `No references to ${q}`
      : hits.map((h) => `${h.path}:${h.line} ${h.name}`).join('\n')
  return { ok: true, detail, hits }
}

export function relatedFiles(
  workspacePath: string,
  path: string,
  max = 8
): { ok: boolean; detail: string; paths: string[] } {
  const index = ensureCodeIndex(workspacePath)
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const names = new Set(index.symbols.filter((s) => s.path === rel || s.path.endsWith('/' + rel)).map((s) => s.name))
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
    scheduleBackgroundRebuild(workspacePath)
    return 'Code index: building in background…'
  } catch {
    return ''
  }
}
