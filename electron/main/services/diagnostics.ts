import { existsSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { runWorkspaceCommand } from './shell-run'
import { findSymbols } from './code-index'

export type DiagnosticItem = {
  path: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string
}

export type DiagnosticsResult = {
  ok: boolean
  diagnostics: DiagnosticItem[]
  detail: string
  cached?: boolean
}

/** While a chat/agent stream is active, skip expensive tsc (return cache). */
let diagnosticsPaused = false

type CacheEntry = {
  key: string
  at: number
  result: DiagnosticsResult
}

let cache: CacheEntry | null = null
let inflight: Promise<DiagnosticsResult> | null = null

const CACHE_TTL_MS = 30_000

export function setDiagnosticsPaused(paused: boolean): void {
  diagnosticsPaused = paused
}

export function invalidateDiagnosticsCache(): void {
  cache = null
}

function mtimeKey(workspacePath: string): string {
  const files = [
    'package.json',
    'tsconfig.json',
    'tsconfig.web.json',
    'tsconfig.node.json',
    'tsconfig.app.json'
  ]
  const parts: string[] = [workspacePath]
  for (const name of files) {
    const p = join(workspacePath, name)
    if (!existsSync(p)) continue
    try {
      parts.push(`${name}:${statSync(p).mtimeMs}`)
    } catch {
      // ignore
    }
  }
  return parts.join('|')
}

/** Parse `tsc` pretty:false / default lines: path(line,col): error TS1234: message */
function parseTscOutput(workspacePath: string, text: string): DiagnosticItem[] {
  const out: DiagnosticItem[] = []
  const re =
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+TS\d+:\s*(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let rel = m[1]!
    if (rel.startsWith(workspacePath)) {
      rel = relative(workspacePath, rel).split(sep).join('/')
    } else {
      rel = rel.replace(/\\/g, '/')
    }
    out.push({
      path: rel,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === 'error' ? 'error' : m[4] === 'warning' ? 'warning' : 'info',
      message: m[5]!.trim(),
      source: 'typescript'
    })
  }
  // Also match "path:line:col - error"
  const re2 = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning):\s*(.+)$/gm
  while ((m = re2.exec(text)) !== null) {
    let rel = m[1]!.replace(/\\/g, '/')
    if (rel.startsWith(workspacePath)) {
      rel = relative(workspacePath, rel).split(sep).join('/')
    }
    out.push({
      path: rel,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === 'error' ? 'error' : 'warning',
      message: m[5]!.trim(),
      source: 'typescript'
    })
  }
  return out
}

async function runCollect(workspacePath: string): Promise<DiagnosticsResult> {
  const hasTs =
    existsSync(join(workspacePath, 'tsconfig.json')) ||
    existsSync(join(workspacePath, 'tsconfig.web.json')) ||
    existsSync(join(workspacePath, 'tsconfig.node.json'))
  if (!hasTs) {
    return { ok: true, diagnostics: [], detail: 'No TypeScript project' }
  }

  // Prefer project typecheck script
  let command = 'npx tsc --noEmit --pretty false'
  try {
    const pkg = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts?.typecheck) command = 'npm run typecheck -- --pretty false'
  } catch {
    // ignore
  }

  const ran = await runWorkspaceCommand(workspacePath, command, { timeoutMs: 90_000 })
  const text = [ran.stdout, ran.stderr].filter(Boolean).join('\n')
  const diagnostics = parseTscOutput(workspacePath, text)
  return {
    ok: true,
    diagnostics,
    detail: `${diagnostics.length} diagnostic(s) from ${command}`
  }
}

export async function collectDiagnostics(
  workspacePath: string,
  opts?: { force?: boolean }
): Promise<DiagnosticsResult> {
  const key = mtimeKey(workspacePath)
  const now = Date.now()

  if (
    !opts?.force &&
    cache &&
    cache.key === key &&
    now - cache.at < CACHE_TTL_MS
  ) {
    return { ...cache.result, cached: true }
  }

  if (diagnosticsPaused && cache) {
    return {
      ...cache.result,
      cached: true,
      detail: `${cache.result.detail} (paused during agent)`
    }
  }
  if (diagnosticsPaused) {
    return {
      ok: true,
      diagnostics: [],
      detail: 'Diagnostics paused while agent is running',
      cached: true
    }
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const result = await runCollect(workspacePath)
      cache = { key, at: Date.now(), result }
      return result
    } finally {
      inflight = null
    }
  })()

  return inflight
}

function snippetAround(
  workspacePath: string,
  relPath: string,
  line: number,
  radius = 2
): string {
  try {
    const abs = join(workspacePath, relPath)
    if (!existsSync(abs)) return ''
    const rows = readFileSync(abs, 'utf8').split(/\r?\n/)
    const idx = Math.max(0, line - 1)
    const from = Math.max(0, idx - radius)
    const to = Math.min(rows.length, idx + radius + 1)
    return rows.slice(from, to).join('\n').slice(0, 600)
  } catch {
    return ''
  }
}

export async function languageHover(
  workspacePath: string,
  filePath: string,
  word: string
): Promise<{ ok: boolean; contents: string }> {
  if (!word.trim()) return { ok: true, contents: '' }
  const found = await findSymbols(workspacePath, word, 8)
  const same = found.hits.filter(
    (h) => h.name === word || h.name.toLowerCase() === word.toLowerCase()
  )
  if (same.length === 0) {
    return {
      ok: true,
      contents: found.hits.length
        ? `Similar symbols:\n${found.hits
            .slice(0, 5)
            .map((h) => `${h.kind} ${h.name} — ${h.path}:${h.line}`)
            .join('\n')}`
        : ''
    }
  }
  const primary =
    same.find((h) => filePath.endsWith(h.path) || h.path === filePath) || same[0]!
  const lines = same.map((h) => `**${h.kind}** \`${h.name}\` — ${h.path}:${h.line}`)
  const snippet = snippetAround(workspacePath, primary.path, primary.line)
  return {
    ok: true,
    contents: [
      primary ? `Defined in this project` : 'Symbol',
      ...lines,
      snippet ? `\`\`\`\n${snippet}\n\`\`\`` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  }
}

export async function goToDefinition(
  workspacePath: string,
  word: string
): Promise<{ ok: boolean; locations: Array<{ path: string; line: number; name: string; kind: string }> }> {
  const found = await findSymbols(workspacePath, word, 20)
  const exact = found.hits.filter((h) => h.name === word)
  const list = (exact.length ? exact : found.hits).slice(0, 12)
  return {
    ok: true,
    locations: list.map((h) => ({
      path: h.path,
      line: h.line,
      name: h.name,
      kind: h.kind
    }))
  }
}
