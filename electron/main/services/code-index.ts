import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { workspaceConfigDir } from './paths'
import { logInfo } from './logger'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.eris',
  'coverage',
  '.next',
  'build'
])

export type SymbolHit = {
  name: string
  kind: string
  path: string
  line: number
}

type IndexRecord = {
  updatedAt: number
  workspacePath: string
  symbols: SymbolHit[]
  files: string[]
}

let memoryIndex: IndexRecord | null = null
let rebuildInFlight: Promise<IndexRecord> | null = null

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
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue
      walk(root, full, files, maxFiles)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(name) && st.size < 800_000) {
      files.push(full)
    }
  }
}

function indexFiles(workspacePath: string, filesAbs: string[]): IndexRecord {
  const symbols: SymbolHit[] = []
  const files: string[] = []
  for (const abs of filesAbs) {
    const rel = relative(workspacePath, abs).split(sep).join('/')
    files.push(rel)
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const { kind, re } of SYMBOL_RES) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          symbols.push({ name: m[1]!, kind, path: rel, line: i + 1 })
          if (symbols.length > 20_000) break
        }
      }
      if (symbols.length > 20_000) break
    }
  }
  const record: IndexRecord = {
    updatedAt: Date.now(),
    workspacePath,
    symbols,
    files
  }
  memoryIndex = record
  try {
    mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
    writeFileSync(indexPath(workspacePath), JSON.stringify(record), 'utf8')
  } catch {
    // ignore persist errors
  }
  logInfo('Code index built', { files: files.length, symbols: symbols.length })
  return record
}

export function buildCodeIndex(workspacePath: string): IndexRecord {
  const filesAbs: string[] = []
  walk(workspacePath, workspacePath, filesAbs, 3000)
  return indexFiles(workspacePath, filesAbs)
}

/** Cooperative rebuild — yields every N files so IPC/UI stay responsive. */
export async function buildCodeIndexAsync(workspacePath: string): Promise<IndexRecord> {
  const filesAbs: string[] = []
  walk(workspacePath, workspacePath, filesAbs, 3000)
  const symbols: SymbolHit[] = []
  const files: string[] = []
  for (let fi = 0; fi < filesAbs.length; fi++) {
    if (fi > 0 && fi % 40 === 0) await yieldEventLoop()
    const abs = filesAbs[fi]!
    const rel = relative(workspacePath, abs).split(sep).join('/')
    files.push(rel)
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const { kind, re } of SYMBOL_RES) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          symbols.push({ name: m[1]!, kind, path: rel, line: i + 1 })
          if (symbols.length > 20_000) break
        }
      }
      if (symbols.length > 20_000) break
    }
  }
  const record: IndexRecord = {
    updatedAt: Date.now(),
    workspacePath,
    symbols,
    files
  }
  memoryIndex = record
  try {
    mkdirSync(workspaceConfigDir(workspacePath), { recursive: true })
    writeFileSync(indexPath(workspacePath), JSON.stringify(record), 'utf8')
  } catch {
    // ignore
  }
  logInfo('Code index built (async)', { files: files.length, symbols: symbols.length })
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
  rebuildInFlight = buildCodeIndexAsync(workspacePath)
    .catch(() => memoryIndex as IndexRecord)
    .finally(() => {
      rebuildInFlight = null
    })
}

/** Call when the workspace tree may have changed (FS watcher / agent writes). */
export function notifyWorkspaceFilesChanged(workspacePath: string): void {
  scheduleBackgroundRebuild(workspacePath)
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

export async function ensureCodeIndexAsync(workspacePath: string): Promise<IndexRecord> {
  const existing = loadCodeIndex(workspacePath)
  if (existing && Date.now() - existing.updatedAt < FRESH_MS) return existing
  if (rebuildInFlight) return rebuildInFlight
  return buildCodeIndexAsync(workspacePath)
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
