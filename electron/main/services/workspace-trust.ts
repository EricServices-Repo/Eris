import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { userDataRoot } from './paths'

/** Workspace-layer settings a cloned repo must not apply until the user trusts the folder. */
export const RISKY_WORKSPACE_SETTINGS: Array<{ path: string[]; label: string }> = [
  { path: ['images'], label: 'Configure image generation and its provider' },
  { path: ['mcp', 'servers'], label: 'Start MCP servers (runs local commands)' },
  {
    path: ['models', 'connections'],
    label: 'Use its own model endpoints (they would receive your code and API keys)'
  },
  { path: ['github', 'host'], label: 'Change the GitHub host (would receive your GitHub token)' },
  { path: ['github', 'tokenRef'], label: 'Choose which stored GitHub token to use' },
  { path: ['github', 'preferredProtocol'], label: 'Change the git protocol' },
  { path: ['ericServices'], label: 'Change the EricServic.es account endpoint' },
  { path: ['agent', 'commandApproval'], label: 'Turn off agent command approval' },
  { path: ['agent', 'allowedCommands'], label: 'Pre-approve agent shell commands' },
  { path: ['general', 'logging', 'directory'], label: 'Write logs to a custom folder' },
  { path: ['intelligence', 'languageServers'], label: 'Start language servers (runs local commands)' },
  { path: ['evals', 'allowUnsafeCommands'], label: 'Let eval agents run commands without approval' }
]

interface TrustStore {
  trusted: string[]
  /** "Always allow" agent commands, per workspace */
  allowedCommands: Record<string, string[]>
}

function storePath(): string {
  return join(userDataRoot(), 'workspace-trust.json')
}

function readStore(): TrustStore {
  try {
    if (!existsSync(storePath())) return { trusted: [], allowedCommands: {} }
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<TrustStore>
    return {
      trusted: Array.isArray(raw.trusted) ? raw.trusted.filter((p) => typeof p === 'string') : [],
      allowedCommands:
        raw.allowedCommands && typeof raw.allowedCommands === 'object' ? raw.allowedCommands : {}
    }
  } catch {
    return { trusted: [], allowedCommands: {} }
  }
}

function writeStore(store: TrustStore): void {
  mkdirSync(userDataRoot(), { recursive: true })
  writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8')
}

export function workspaceKey(workspacePath: string): string {
  try {
    return realpathSync(workspacePath)
  } catch {
    return resolve(workspacePath)
  }
}

export function isWorkspaceTrusted(workspacePath: string | null): boolean {
  if (!workspacePath) return false
  return readStore().trusted.includes(workspaceKey(workspacePath))
}

/** Optional hook — settings registers cache invalidation without a circular import. */
let trustChangedHook: (() => void) | null = null

export function onWorkspaceTrustChanged(fn: () => void): void {
  trustChangedHook = fn
}

export function setWorkspaceTrusted(workspacePath: string, trusted: boolean): void {
  const store = readStore()
  const key = workspaceKey(workspacePath)
  const next = new Set(store.trusted)
  if (trusted) next.add(key)
  else next.delete(key)
  writeStore({ ...store, trusted: [...next] })
  // Trust changes which workspace layer keys apply — drop resolved cache.
  trustChangedHook?.()
}

function hasPath(obj: unknown, path: string[]): boolean {
  let cur = obj as Record<string, unknown> | undefined
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return false
    cur = cur[key] as Record<string, unknown> | undefined
  }
  if (Array.isArray(cur)) return cur.length > 0
  return cur !== undefined
}

function deletePath(obj: Record<string, unknown>, path: string[]): void {
  const parents: Array<Record<string, unknown>> = []
  let cur: Record<string, unknown> | undefined = obj
  for (const key of path.slice(0, -1)) {
    const nextCur: unknown = cur?.[key]
    if (!nextCur || typeof nextCur !== 'object') return
    parents.push(cur!)
    cur = { ...(nextCur as Record<string, unknown>) }
    parents[parents.length - 1]![key] = cur
  }
  if (cur) delete cur[path[path.length - 1]!]
}

/** Labels of risky settings present in a workspace layer. */
export function riskyWorkspaceSettings(layer: unknown): string[] {
  return RISKY_WORKSPACE_SETTINGS.filter((r) => hasPath(layer, r.path)).map((r) => r.label)
}

/** Workspace layer with risky keys removed (copy). */
export function stripRiskyWorkspaceSettings<T extends Record<string, unknown>>(layer: T): T {
  const copy = { ...layer } as Record<string, unknown>
  for (const r of RISKY_WORKSPACE_SETTINGS) deletePath(copy, r.path)
  return copy as T
}

export function workspaceAllowedCommands(workspacePath: string | null): string[] {
  if (!workspacePath) return []
  return readStore().allowedCommands[workspaceKey(workspacePath)] ?? []
}

export function addWorkspaceAllowedCommand(workspacePath: string, command: string): void {
  const store = readStore()
  const key = workspaceKey(workspacePath)
  const list = new Set(store.allowedCommands[key] ?? [])
  list.add(command)
  writeStore({ ...store, allowedCommands: { ...store.allowedCommands, [key]: [...list] } })
}
