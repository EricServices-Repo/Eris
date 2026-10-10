import { watch, type FSWatcher } from 'fs'
import { basename } from 'path'

const IGNORE_NAMES = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.DS_Store',
  'tsconfig.tsbuildinfo',
  'tsconfig.web.tsbuildinfo',
  // Internal cache / index — writing these must not re-trigger the watcher
  'code-index.json',
  'cache'
])

/** Paths under .eris that are safe to ignore (agent/index feedback). */
function shouldIgnoreErisRel(rel: string): boolean {
  const n = rel.split('\\').join('/')
  if (!n.includes('.eris/')) return false
  if (n.endsWith('/code-index.json') || n.includes('/code-index.json')) return true
  if (n.includes('/.eris/cache/') || n.includes('/.eris/checkpoints/')) return true
  return false
}

export type WorkspaceFsChangeHandler = (payload: {
  workspacePath: string
  path: string
  eventType: string
}) => void

let watcher: FSWatcher | null = null
let watchedPath: string | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pending: { path: string; eventType: string } | null = null
let handler: WorkspaceFsChangeHandler | null = null

function shouldIgnore(name: string): boolean {
  if (!name) return true
  if (IGNORE_NAMES.has(name)) return true
  if (name.startsWith('.')) {
    // Allow .eris config changes through (skills/settings) but skip heavy noise
    if (name === '.eris') return false
    return name !== '.env' && name !== '.env.local'
  }
  return false
}

export function setWorkspaceFsChangeHandler(next: WorkspaceFsChangeHandler | null): void {
  handler = next
}

export function stopWorkspaceWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pending = null
  if (watcher) {
    try {
      watcher.close()
    } catch {
      /* ignore */
    }
    watcher = null
  }
  watchedPath = null
}

export function startWorkspaceWatcher(workspacePath: string | null): void {
  stopWorkspaceWatcher()
  if (!workspacePath) return
  watchedPath = workspacePath
  try {
    watcher = watch(workspacePath, { recursive: true }, (eventType, filename) => {
      if (!watchedPath || !handler) return
      const name = filename ? basename(String(filename)) : ''
      const rel = filename ? String(filename).split('\\').join('/') : ''
      const parts = rel.split('/')
      if (parts.some((p) => IGNORE_NAMES.has(p))) return
      if (shouldIgnoreErisRel(rel) || shouldIgnoreErisRel(name)) return
      if (name === 'code-index.json') return
      if (shouldIgnore(name) && !rel.includes('.eris/')) return
      pending = { path: rel || '.', eventType: String(eventType || 'change') }
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const p = pending
        pending = null
        if (!p || !watchedPath || !handler) return
        handler({ workspacePath: watchedPath, path: p.path, eventType: p.eventType })
      }, 400)
    })
    watcher.on('error', () => {
      // FSWatcher can fail on some volumes; leave stopped until next workspace open
      stopWorkspaceWatcher()
    })
  } catch {
    watcher = null
    watchedPath = null
  }
}
