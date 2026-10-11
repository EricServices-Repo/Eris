import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { workspaceContextPath } from './paths'

export interface WorkspaceContextDoc {
  body: string
  /** Short pin for every prompt turn */
  pin: string
  updatedAt: number
  empty: boolean
}

const PIN_MAX = 800
const FULL_PROMPT_MAX = 6000
const DEFAULT_CONTEXT = `# Workspace context

## Summary
Short facts the agent should always know (stack, entrypoints, conventions).

## Reference
Key paths, architecture notes, env quirks, “do not touch” areas.

## Notes
`

type CacheEntry = {
  mtimeMs: number
  size: number
  body: string
  pin: string
}

const cache = new Map<string, CacheEntry>()

function extractSection(body: string, heading: string): string {
  const re = new RegExp(
    `^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    'im'
  )
  const m = body.match(re)
  return m?.[1]?.trim() ?? ''
}

/** Prefer ## Summary; else first meaningful paragraph. Cap for prompt efficiency. */
export function extractContextPin(body: string, max = PIN_MAX): string {
  const trimmed = body.trim()
  if (!trimmed) return ''

  const summary = extractSection(trimmed, 'Summary')
  if (summary) {
    return summary.length <= max ? summary : `${summary.slice(0, max - 1)}…`
  }

  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '---')
  const blob = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (!blob) return ''
  return blob.length <= max ? blob : `${blob.slice(0, max - 1)}…`
}

function readRaw(workspacePath: string): { body: string; mtimeMs: number; size: number } {
  const path = workspaceContextPath(workspacePath)
  if (!existsSync(path)) {
    return { body: '', mtimeMs: 0, size: 0 }
  }
  const st = statSync(path)
  return {
    body: readFileSync(path, 'utf8'),
    mtimeMs: st.mtimeMs,
    size: st.size
  }
}

function fromCacheOrDisk(workspacePath: string): CacheEntry {
  const raw = readRaw(workspacePath)
  const hit = cache.get(workspacePath)
  if (hit && hit.mtimeMs === raw.mtimeMs && hit.size === raw.size) {
    return hit
  }
  const entry: CacheEntry = {
    mtimeMs: raw.mtimeMs,
    size: raw.size,
    body: raw.body,
    pin: extractContextPin(raw.body)
  }
  cache.set(workspacePath, entry)
  return entry
}

export function invalidateWorkspaceContextCache(workspacePath: string | null): void {
  if (!workspacePath) {
    cache.clear()
    return
  }
  cache.delete(workspacePath)
}

export function ensureWorkspaceContext(workspacePath: string): void {
  const path = workspaceContextPath(workspacePath)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) return
  writeFileSync(path, DEFAULT_CONTEXT, 'utf8')
  invalidateWorkspaceContextCache(workspacePath)
}

export function getWorkspaceContext(workspacePath: string | null): WorkspaceContextDoc {
  if (!workspacePath) {
    return { body: '', pin: '', updatedAt: 0, empty: true }
  }
  ensureWorkspaceContext(workspacePath)
  const entry = fromCacheOrDisk(workspacePath)
  return {
    body: entry.body,
    pin: entry.pin,
    updatedAt: entry.mtimeMs,
    empty: !entry.body.trim() || entry.body.trim() === DEFAULT_CONTEXT.trim()
  }
}

export function saveWorkspaceContext(workspacePath: string, body: string): WorkspaceContextDoc {
  const path = workspaceContextPath(workspacePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  invalidateWorkspaceContextCache(workspacePath)
  return getWorkspaceContext(workspacePath)
}

/** Replace or create the ## Summary section; keeps other sections. */
export function setContextSummary(workspacePath: string, summary: string): WorkspaceContextDoc {
  const current = getWorkspaceContext(workspacePath).body || DEFAULT_CONTEXT
  const text = summary.trim()
  const section = `## Summary\n${text}\n`
  let next: string
  if (/^##\s+Summary\s*$/im.test(current)) {
    next = current.replace(/^##\s+Summary\s*\n[\s\S]*?(?=^##\s+|(?![\s\S]))/im, `${section}\n`)
  } else if (/^#\s+/m.test(current)) {
    next = current.replace(/^(#\s+[^\n]+\n+)/, `$1\n${section}\n`)
  } else {
    next = `# Workspace context\n\n${section}\n${current}`
  }
  return saveWorkspaceContext(workspacePath, next)
}

/** Append a dated bullet under ## Notes (creates section if missing). */
export function appendContextNote(workspacePath: string, note: string): WorkspaceContextDoc {
  const trimmed = note.trim()
  if (!trimmed) return getWorkspaceContext(workspacePath)
  const stamp = new Date().toISOString().slice(0, 10)
  const bullet = trimmed.startsWith('-') ? trimmed : `- ${trimmed}`
  const line = bullet.includes(stamp) ? bullet : `- (${stamp}) ${trimmed.replace(/^[-*]\s*/, '')}`

  let body = getWorkspaceContext(workspacePath).body || DEFAULT_CONTEXT
  if (!/^##\s+Notes\s*$/im.test(body)) {
    body = `${body.trimEnd()}\n\n## Notes\n`
  }
  body = body.replace(/^(##\s+Notes\s*\n)/im, `$1${line}\n`)
  return saveWorkspaceContext(workspacePath, body)
}

/**
 * Prompt fragment: pin only by default (cheap every turn).
 * Use full=true sparingly (e.g. agent read_context tool).
 */
export function formatWorkspaceContextPrompt(
  workspacePath: string | null,
  opts?: { full?: boolean; maxFull?: number }
): string {
  if (!workspacePath) return ''
  // Avoid creating the file just to inject empty context on every chat.
  const path = workspaceContextPath(workspacePath)
  if (!existsSync(path)) return ''

  const entry = fromCacheOrDisk(workspacePath)
  if (!entry.body.trim()) return ''

  if (opts?.full) {
    const max = opts.maxFull ?? FULL_PROMPT_MAX
    const body =
      entry.body.length <= max
        ? entry.body
        : `${entry.body.slice(0, max)}\n\n[truncated ${entry.body.length - max} chars — edit .eris/context.md]`
    return `Workspace reference context (.eris/context.md):\n${body}`
  }

  if (!entry.pin) return ''
  return `Workspace context (pinned summary — full notes in .eris/context.md; use read_context tool if needed):\n${entry.pin}`
}
