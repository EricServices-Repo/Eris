import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Always skipped directory names (basename match). */
export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.eris',
  'coverage',
  '.next',
  'build',
  'vendor',
  'target',
  '__pycache__',
  '.turbo',
  '.cache',
  'Pods'
])

type IgnoreRule = {
  /** Negated rules re-include after a skip. */
  negate: boolean
  /** Directory-only when pattern ends with /. */
  dirOnly: boolean
  /** Anchored to repo root when pattern starts with /. */
  anchored: boolean
  /** Simple glob → RegExp for path segments. */
  re: RegExp
}

const cache = new Map<string, { at: number; rules: IgnoreRule[] }>()
const CACHE_MS = 10_000

function globToRegExp(pattern: string): RegExp {
  let p = pattern
  // ** matches across segments; * within a segment
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*' && p[i + 1] === '*') {
      out += '.*'
      i++
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if ('+.^${}()|[]\\'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

function parseIgnoreFile(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let negate = false
    let body = line
    if (body.startsWith('!')) {
      negate = true
      body = body.slice(1)
    }
    let dirOnly = false
    if (body.endsWith('/')) {
      dirOnly = true
      body = body.slice(0, -1)
    }
    let anchored = false
    if (body.startsWith('/')) {
      anchored = true
      body = body.slice(1)
    }
    if (!body) continue
    rules.push({
      negate,
      dirOnly,
      anchored,
      re: globToRegExp(body)
    })
  }
  return rules
}

function loadIgnoreRules(workspacePath: string): IgnoreRule[] {
  const hit = cache.get(workspacePath)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules
  const rules: IgnoreRule[] = []
  for (const name of ['.gitignore', '.erisignore']) {
    const path = join(workspacePath, name)
    if (!existsSync(path)) continue
    try {
      rules.push(...parseIgnoreFile(readFileSync(path, 'utf8')))
    } catch {
      /* ignore */
    }
  }
  cache.set(workspacePath, { at: Date.now(), rules })
  return rules
}

/** Invalidate cached ignore rules (e.g. after .gitignore edit). */
export function invalidateWorkspaceIgnoreCache(workspacePath?: string): void {
  if (workspacePath) cache.delete(workspacePath)
  else cache.clear()
}

/**
 * Whether a workspace-relative path should be skipped for indexing / retrieve walks.
 * `isDir` helps directory-only gitignore patterns.
 */
export function shouldSkipWorkspacePath(
  workspacePath: string,
  relPath: string,
  isDir = false
): boolean {
  const rel = relPath.split('\\').join('/').replace(/^\.\//, '')
  if (!rel) return true
  const parts = rel.split('/')
  const base = parts[parts.length - 1] || ''
  // Apply hard exclusions to every ancestor, including paths returned by rg or
  // loaded from an older index. A normal filename inside .eris is still metadata.
  if (parts.some((part) => DEFAULT_SKIP_DIRS.has(part))) return true
  if (base.startsWith('.') && base !== '.github' && !base.startsWith('.env')) {
    // Skip most dotdirs/files; allow .github and env files for search.
    if (isDir || parts.length > 1) {
      for (const p of parts) {
        if (p.startsWith('.') && p !== '.github' && !p.startsWith('.env')) {
          if (DEFAULT_SKIP_DIRS.has(p) || p === '.eris') return true
          if (p !== '.github' && !p.startsWith('.env')) {
            // skip .vscode, .idea, etc. for indexing
            if (p === '.vscode' || p === '.idea' || p === '.husky') return true
          }
        }
      }
    }
  }

  const rules = loadIgnoreRules(workspacePath)
  if (rules.length === 0) return false

  let ignored = false
  for (const rule of rules) {
    const candidates = rule.anchored
      ? [rel]
      : [rel, base, ...parts.map((_, i) => parts.slice(i).join('/'))]
    // Directory rules like `vendor/` also ignore descendants.
    if (rule.dirOnly) {
      const dirMatch =
        isDir && candidates.some((c) => rule.re.test(c))
          ? true
          : parts.some((_, i) => {
              const prefix = parts.slice(0, i + 1).join('/')
              return rule.re.test(prefix) || (!rule.anchored && rule.re.test(parts[i]!))
            })
      if (!dirMatch) continue
      ignored = !rule.negate
      continue
    }
    const matched = candidates.some((c) => rule.re.test(c))
    if (!matched) continue
    ignored = !rule.negate
  }
  return ignored
}

export function shouldSkipDir(workspacePath: string, dirName: string, relDir: string): boolean {
  if (DEFAULT_SKIP_DIRS.has(dirName)) return true
  if (dirName.startsWith('.') && dirName !== '.github') return true
  return shouldSkipWorkspacePath(workspacePath, relDir || dirName, true)
}
