import { watch, type FSWatcher } from 'fs'
import { createRequire } from 'module'
import { basename, relative, resolve, sep } from 'path'

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
  'code-index.json.tmp',
  'cache'
])

/** Globs passed to @parcel/watcher so the native layer never reports them. */
const NATIVE_IGNORE = [
  'node_modules',
  '**/node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.eris/cache',
  '.eris/checkpoints',
  '.eris/runs',
  '.eris/sessions',
  '.eris/chats',
  '.ericservices-ide/chats',
  '.eris/code-index.json',
  '.eris/code-index.json.tmp',
  '**/.DS_Store',
  '**/*.tsbuildinfo'
]

const DEBOUNCE_MS = 400
const DEFAULT_SUPPRESS_MS = 1500

/** Paths under .eris that are safe to ignore (agent/index feedback). */
export function shouldIgnoreErisRel(rel: string): boolean {
  const n = `/${rel.split('\\').join('/')}`.replace('/.ericservices-ide/', '/.eris/')
  if (!n.includes('/.eris/')) return false
  if (n.endsWith('/code-index.json') || n.endsWith('/code-index.json.tmp')) return true
  if (
    n.includes('/.eris/cache/') ||
    n.includes('/.eris/checkpoints/') ||
    n.includes('/.eris/runs/') ||
    n.includes('/.eris/sessions/')
    || n.includes('/.eris/chats/')
  ) {
    return true
  }
  return false
}

function shouldIgnoreName(name: string): boolean {
  if (!name) return true
  if (IGNORE_NAMES.has(name)) return true
  if (name.startsWith('.')) {
    // Allow .eris config changes through (skills/settings) but skip heavy noise
    if (name === '.eris') return false
    return name !== '.env' && name !== '.env.local'
  }
  return false
}

/** True when a workspace-relative path should never reach the change handler. */
export function shouldIgnoreWorkspaceRel(rel: string): boolean {
  const n = rel.split('\\').join('/')
  const parts = n.split('/')
  if (parts.some((p) => IGNORE_NAMES.has(p))) return true
  if (shouldIgnoreErisRel(n)) return true
  const name = basename(n)
  return shouldIgnoreName(name) && !n.includes('.eris/')
}

export type WorkspaceFsChangeHandler = (payload: {
  workspacePath: string
  path: string
  /** Batched relative paths from the debounce window (preferred for index patch). */
  paths?: string[]
  eventType: string
}) => void

type ParcelSubscription = { unsubscribe: () => Promise<void> }
type ParcelWatcher = {
  subscribe: (
    dir: string,
    fn: (err: Error | null, events: Array<{ path: string; type: string }>) => void,
    opts?: { ignore?: string[] }
  ) => Promise<ParcelSubscription>
}

let fsWatcher: FSWatcher | null = null
let parcelSub: ParcelSubscription | null = null
let generation = 0
let watchedPath: string | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingPaths = new Set<string>()
let pendingEventType = 'change'
let handler: WorkspaceFsChangeHandler | null = null
const suppressed = new Map<string, number>()
let parcel: ParcelWatcher | null | undefined

function loadParcel(): ParcelWatcher | null {
  if (parcel !== undefined) return parcel
  try {
    parcel = createRequire(__filename)('@parcel/watcher') as ParcelWatcher
  } catch {
    parcel = null
  }
  return parcel
}

/** Ignore watcher events for this absolute path for a short window (our own writes). */
export function suppressWatcherFor(absPath: string, ms = DEFAULT_SUPPRESS_MS): void {
  suppressed.set(resolve(absPath), Date.now() + ms)
}

function isSuppressed(absPath: string): boolean {
  const key = resolve(absPath)
  const until = suppressed.get(key)
  if (until === undefined) return false
  if (Date.now() > until) {
    suppressed.delete(key)
    return false
  }
  return true
}

export function setWorkspaceFsChangeHandler(next: WorkspaceFsChangeHandler | null): void {
  handler = next
}

export function stopWorkspaceWatcher(): void {
  generation++
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPaths.clear()
  if (fsWatcher) {
    try {
      fsWatcher.close()
    } catch {
      /* ignore */
    }
    fsWatcher = null
  }
  if (parcelSub) {
    void parcelSub.unsubscribe().catch(() => undefined)
    parcelSub = null
  }
  watchedPath = null
}

function onRawEvent(root: string, absPath: string, eventType: string): void {
  if (!watchedPath || !handler || watchedPath !== root) return
  if (isSuppressed(absPath)) return
  const rel = relative(root, absPath).split(sep).join('/')
  if (!rel || rel.startsWith('..')) return
  if (shouldIgnoreWorkspaceRel(rel)) return
  pendingPaths.add(rel)
  pendingEventType = eventType
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!pendingPaths.size || !watchedPath || !handler) return
    const paths = [...pendingPaths]
    pendingPaths.clear()
    handler({
      workspacePath: watchedPath,
      path: paths[0]!,
      paths,
      eventType: pendingEventType
    })
  }, DEBOUNCE_MS)
}

function startFsWatch(root: string): void {
  try {
    fsWatcher = watch(root, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      onRawEvent(root, resolve(root, String(filename)), String(eventType || 'change'))
    })
    fsWatcher.on('error', () => {
      // FSWatcher can fail on some volumes; leave stopped until next workspace open
      stopWorkspaceWatcher()
    })
  } catch {
    fsWatcher = null
  }
}

export function startWorkspaceWatcher(workspacePath: string | null): void {
  stopWorkspaceWatcher()
  if (!workspacePath) return
  const root = resolve(workspacePath)
  watchedPath = root
  const gen = generation
  const native = loadParcel()
  if (!native) {
    startFsWatch(root)
    return
  }
  native
    .subscribe(
      root,
      (err, events) => {
        if (err || gen !== generation) return
        for (const e of events) onRawEvent(root, e.path, e.type === 'update' ? 'change' : 'rename')
      },
      { ignore: NATIVE_IGNORE }
    )
    .then((sub) => {
      if (gen !== generation) {
        void sub.unsubscribe().catch(() => undefined)
        return
      }
      parcelSub = sub
    })
    .catch(() => {
      if (gen === generation) startFsWatch(root)
    })
}
