import { spawn } from 'child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from 'fs'
import { join, relative, sep } from 'path'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace-fs'
import { buildWorkspaceProcessEnv } from './workspace-env'
import { cosine, hashEmbed } from './embeddings'
import { ensureCodeIndexAsync, loadCodeIndex } from './code-index'
import { shouldSkipDir, shouldSkipWorkspacePath } from './workspace-ignore'

const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.zsh',
  '.bash',
  '.env',
  '.txt',
  '.svg'
])

export type SearchHit = {
  path: string
  line: number
  text: string
}

function isProbablyText(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXT.has(lower.slice(dot))
}

function runRg(
  workspacePath: string,
  pattern: string,
  glob?: string,
  maxResults = 40
): Promise<SearchHit[] | null> {
  return new Promise((resolve) => {
    const args = [
      '--json',
      '--max-count',
      '5',
      '-m',
      String(maxResults),
      '--hidden',
      '--glob',
      '!node_modules',
      '--glob',
      '!.git',
      '--glob',
      '!out',
      '--glob',
      '!dist'
    ]
    if (glob) args.push('--glob', glob)
    args.push(pattern, '.')
    const child = spawn('rg', args, {
      cwd: workspacePath,
      env: buildWorkspaceProcessEnv(workspacePath)
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000)
    child.stdout.on('data', (d) => {
      stdout += String(d)
      if (stdout.length > 2_000_000) child.kill('SIGTERM')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && code !== 1) {
        resolve(null)
        return
      }
      const hits: SearchHit[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as {
            type?: string
            data?: {
              path?: { text?: string }
              line_number?: number
              lines?: { text?: string }
            }
          }
          if (row.type !== 'match' || !row.data?.path?.text) continue
          hits.push({
            path: row.data.path.text.split(sep).join('/'),
            line: row.data.line_number || 0,
            text: (row.data.lines?.text || '').replace(/\n$/, '')
          })
          if (hits.length >= maxResults) break
        } catch {
          // skip
        }
      }
      resolve(hits)
    })
  })
}

function walkFiles(root: string, dir: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= maxFiles) return
    if (name === '.DS_Store') continue
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
      walkFiles(root, full, out, maxFiles)
    } else if (
      st.isFile() &&
      st.size < 1_500_000 &&
      isProbablyText(full) &&
      !shouldSkipWorkspacePath(root, rel, false)
    ) {
      out.push(full)
    }
  }
}

function fallbackGrep(
  workspacePath: string,
  pattern: string,
  globHint?: string,
  maxResults = 40
): SearchHit[] {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const files: string[] = []
  walkFiles(workspacePath, workspacePath, files, 4000)
  const hits: SearchHit[] = []
  for (const abs of files) {
    const rel = relative(workspacePath, abs).split(sep).join('/')
    if (globHint) {
      const needle = globHint.replace(/^\*\./, '.').replace(/\*/g, '')
      if (needle && !rel.includes(needle.replace(/^\./, ''))) {
        // rough filter: extension or substring
        if (globHint.startsWith('*.') && !rel.endsWith(globHint.slice(1))) continue
      }
    }
    let content: string
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue
      hits.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 240) })
      if (hits.length >= maxResults) return hits
    }
  }
  return hits
}

export async function workspaceGrep(
  workspacePath: string,
  pattern: string,
  options?: { glob?: string; maxResults?: number }
): Promise<{ ok: boolean; detail: string; hits: SearchHit[] }> {
  if (!pattern.trim()) {
    return { ok: false, detail: 'pattern is required', hits: [] }
  }
  resolveInWorkspace(workspacePath, '.')
  const maxResults = options?.maxResults ?? 40
  const rgHits = await runRg(workspacePath, pattern, options?.glob, maxResults)
  const hits = rgHits ?? fallbackGrep(workspacePath, pattern, options?.glob, maxResults)
  if (hits.length === 0) {
    return {
      ok: true,
      detail: `No matches for /${pattern}/${options?.glob ? ` in ${options.glob}` : ''}`,
      hits
    }
  }
  const detail = hits
    .map((h) => `${h.path}:${h.line}: ${h.text}`)
    .join('\n')
  return {
    ok: true,
    detail: `${hits.length} hit(s)${rgHits ? ' (rg)' : ' (scan)'}:\n${detail}`,
    hits
  }
}

export function workspaceGlob(
  workspacePath: string,
  pattern: string,
  maxResults = 80
): { ok: boolean; detail: string; paths: string[] } {
  const raw = pattern.trim() || '**/*'
  resolveInWorkspace(workspacePath, '.')
  const files: string[] = []
  walkFiles(workspacePath, workspacePath, files, 8000)

  // Simple glob: support *, **, and extension filters
  const escaped = raw
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*')
  let re: RegExp
  try {
    re = new RegExp(`^${escaped}$`, 'i')
  } catch {
    re = /.*/
  }

  const paths: string[] = []
  for (const abs of files) {
    const rel = toWorkspaceRelative(workspacePath, abs)
    if (re.test(rel) || re.test(rel.split('/').pop() || '')) {
      paths.push(rel)
      if (paths.length >= maxResults) break
    }
  }
  return {
    ok: true,
    detail:
      paths.length === 0
        ? `No files matching ${raw}`
        : paths.map((p) => p).join('\n'),
    paths
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

type RetrieveResult = { ok: boolean; detail: string; paths: string[] }

const retrieveCache = new Map<string, { at: number; result: RetrieveResult }>()
const RETRIEVE_CACHE_MS = 30_000

function retrievalSnippet(content: string, terms: string[]): string {
  const lines = content.slice(0, 100_000).split('\n')
  let bestIndex = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (line.includes(term) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  const start = bestIndex < 0 ? 0 : Math.max(0, bestIndex - 2)
  const selected = lines.slice(start, start + 7)
  return selected.map((line, index) => `${start + index + 1}: ${line}`).join('\n').slice(0, 500)
}

/** Rank workspace files for a natural-language / keyword query (sync). */
export function retrieveContext(
  workspacePath: string,
  query: string,
  maxFiles = 8
): RetrieveResult {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2)
    .slice(0, 12)
  if (terms.length === 0) {
    return { ok: true, detail: '(no retrieval terms)', paths: [] }
  }
  if (!existsSync(workspacePath)) {
    return { ok: false, detail: 'Workspace missing', paths: [] }
  }
  const files: string[] = []
  walkFiles(workspacePath, workspacePath, files, 5000)
  const scored: Array<{ path: string; score: number; snippet: string }> = []
  for (const abs of files) {
    const rel = toWorkspaceRelative(workspacePath, abs)
    let score = 0
    const lowerPath = rel.toLowerCase()
    for (const t of terms) {
      if (lowerPath.includes(t)) score += 5
    }
    let content = ''
    try {
      content = readFileSync(abs, 'utf8').slice(0, 8000)
    } catch {
      continue
    }
    const lower = content.toLowerCase()
    for (const t of terms) {
      const count = lower.split(t).length - 1
      score += Math.min(8, count)
    }
    if (score <= 0) continue
    const snippet = content.split('\n').slice(0, 8).join('\n').slice(0, 400)
    scored.push({ path: rel, score, snippet })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, maxFiles)
  const detail = top
    .map((t) => `### ${t.path} (score ${t.score})\n${t.snippet}`)
    .join('\n\n')
  return {
    ok: true,
    detail: top.length ? detail : 'No relevant files found',
    paths: top.map((t) => t.path)
  }
}

/**
 * Repo-scale retrieve: rank from the code index (path + symbols + embeddings) first,
 * then read only the top candidates for snippets. Falls back to a bounded walk when
 * the index is cold. Short-TTL cache avoids repeat work for the same query.
 */
export async function retrieveContextAsync(
  workspacePath: string,
  query: string,
  maxFiles = 8
): Promise<RetrieveResult> {
  const cacheKey = `${workspacePath}\0${query}\0${maxFiles}`
  const hit = retrieveCache.get(cacheKey)
  if (hit && Date.now() - hit.at < RETRIEVE_CACHE_MS) return hit.result

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2)
    .slice(0, 16)
  if (terms.length === 0) {
    return { ok: true, detail: '(no retrieval terms)', paths: [] }
  }
  if (!existsSync(workspacePath)) {
    return { ok: false, detail: 'Workspace missing', paths: [] }
  }

  const index = await ensureCodeIndexAsync(workspacePath).catch(() => loadCodeIndex(workspacePath))
  const queryVec = hashEmbed(query)
  const scored = new Map<string, number>()

  if (index && index.files.length > 0) {
    for (let i = 0; i < index.files.length; i++) {
      if (i > 0 && i % 200 === 0) await yieldEventLoop()
      const rel = index.files[i]!
      let score = 0
      const lowerPath = rel.toLowerCase()
      for (const t of terms) {
        if (lowerPath.includes(t)) score += 6
        if (lowerPath.split('/').pop()?.includes(t)) score += 3
      }
      const embedding = index.embeddings?.[rel]
      if (queryVec && embedding) score += cosine(queryVec, embedding) * 18
      if (score > 0) scored.set(rel, (scored.get(rel) ?? 0) + score)
    }
    // Symbol name hits are strong signals for “where is X?”
    for (let i = 0; i < index.symbols.length; i++) {
      if (i > 0 && i % 400 === 0) await yieldEventLoop()
      const s = index.symbols[i]!
      const name = s.name.toLowerCase()
      let bump = 0
      for (const t of terms) {
        if (name === t) bump += 14
        else if (name.includes(t)) bump += 7
      }
      if (bump) scored.set(s.path, (scored.get(s.path) ?? 0) + bump)
    }
  }

  // If the index is thin, supplement with a bounded content walk.
  if (scored.size < maxFiles * 2) {
    const files: string[] = []
    walkFiles(workspacePath, workspacePath, files, 4000)
    for (let i = 0; i < files.length; i++) {
      if (i > 0 && i % 80 === 0) await yieldEventLoop()
      const abs = files[i]!
      const rel = toWorkspaceRelative(workspacePath, abs)
      if (scored.has(rel) && (scored.get(rel) ?? 0) > 20) continue
      let score = scored.get(rel) ?? 0
      const lowerPath = rel.toLowerCase()
      for (const t of terms) {
        if (lowerPath.includes(t)) score += 5
      }
      let content = ''
      try {
        content = readFileSync(abs, 'utf8').slice(0, 6000)
      } catch {
        continue
      }
      const lower = content.toLowerCase()
      for (const t of terms) {
        score += Math.min(8, lower.split(t).length - 1)
      }
      if (score > 0) scored.set(rel, score)
    }
  }

  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(maxFiles * 3, 24))
  const top: Array<{ path: string; score: number; snippet: string }> = []
  for (const [rel, score] of ranked) {
    if (top.length >= maxFiles) break
    const abs = join(workspacePath, ...rel.split('/'))
    let snippet = ''
    try {
      snippet = retrievalSnippet(readFileSync(abs, 'utf8'), terms)
    } catch {
      continue
    }
    top.push({ path: rel, score, snippet })
  }

  const detail = top
    .map((t) => `### ${t.path} (score ${t.score.toFixed(1)})\n${t.snippet}`)
    .join('\n\n')
  const result: RetrieveResult = {
    ok: true,
    detail: top.length ? detail : 'No relevant files found',
    paths: top.map((t) => t.path)
  }
  retrieveCache.set(cacheKey, { at: Date.now(), result })
  if (retrieveCache.size > 40) {
    const oldest = [...retrieveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) retrieveCache.delete(oldest[0])
  }
  return result
}
