import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AppSettings, SettingsPatch, SettingsScope } from '../../../src/shared/settings-schema'
import { SettingsSchema } from '../../../src/shared/settings-schema'
import {
  defaultsPath,
  userSettingsPath,
  workspaceSettingsPath,
  userDataRoot
} from './paths'
import {
  isWorkspaceTrusted,
  riskyWorkspaceSettings,
  setWorkspaceTrusted,
  stripRiskyWorkspaceSettings
} from './workspace-trust'

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof out[key] === 'object' &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

let cachedDefaults: AppSettings | null = null

export function getDefaults(): AppSettings {
  if (cachedDefaults) return cachedDefaults
  const raw = readJson<AppSettings>(defaultsPath())
  if (!raw) {
    throw new Error(`Missing defaults at ${defaultsPath()}`)
  }
  cachedDefaults = SettingsSchema.parse(raw)
  return cachedDefaults
}

export function getUserSettings(): SettingsPatch {
  return readJson<SettingsPatch>(userSettingsPath()) ?? {}
}

export function getWorkspaceSettings(workspacePath: string | null): SettingsPatch {
  if (!workspacePath) return {}
  return readJson<SettingsPatch>(workspaceSettingsPath(workspacePath)) ?? {}
}

/** Workspace layer as applied: risky keys are dropped until the folder is trusted. */
export function getEffectiveWorkspaceSettings(workspacePath: string | null): SettingsPatch {
  const layer = getWorkspaceSettings(workspacePath)
  if (!workspacePath || isWorkspaceTrusted(workspacePath)) return layer
  return stripRiskyWorkspaceSettings(layer as Record<string, unknown>) as SettingsPatch
}

function sanitizeLegacyModels(raw: Record<string, unknown>): Record<string, unknown> {
  const models = { ...(raw.models as Record<string, unknown> | undefined) }
  // Drop pre-builtin Ollama-centric keys; connections + builtin Composer replace them.
  delete models.provider
  delete models.ollama
  if (!models.connections) {
    models.connections = [
      {
        id: 'builtin',
        name: 'Built-in Composer',
        type: 'builtin',
        provider: 'builtin',
        enabled: true,
        baseUrl: '',
        apiKeyRef: '',
        models: ['builtin:composer-lite', 'builtin:composer']
      }
    ]
  } else if (Array.isArray(models.connections)) {
    models.connections = (models.connections as Array<Record<string, unknown>>).map((c) => {
      // Legacy / synced profiles sometimes stored provider presets as `type`
      // (e.g. "openai", "ollama"). Canonical types are only builtin | openai-compatible.
      const rawType = typeof c.type === 'string' ? c.type : ''
      if (rawType === 'builtin') {
        const list = Array.isArray(c.models) ? [...(c.models as string[])] : []
        for (const ref of ['builtin:composer-lite', 'builtin:composer']) {
          if (!list.includes(ref)) list.push(ref)
        }
        return { ...c, type: 'builtin', provider: 'builtin', models: list }
      }
      const provider =
        typeof c.provider === 'string' && c.provider
          ? c.provider
          : rawType && rawType !== 'openai-compatible'
            ? rawType
            : 'custom'
      return { ...c, type: 'openai-compatible', provider }
    })
  }
  if (!models.defaultModel || models.defaultModel === '') {
    models.defaultModel = 'builtin:composer-lite'
  }
  return { ...raw, models }
}

function sanitizeEditor(raw: Record<string, unknown>): Record<string, unknown> {
  const editor = { ...((raw.editor as Record<string, unknown> | undefined) || {}) }
  if (typeof editor.inlineSuggest !== 'boolean') editor.inlineSuggest = true
  return { ...raw, editor }
}

function sanitizeGeneral(raw: Record<string, unknown>): Record<string, unknown> {
  const general = { ...((raw.general as Record<string, unknown> | undefined) || {}) }
  const logging = { ...((general.logging as Record<string, unknown> | undefined) || {}) }
  if (typeof logging.enabled !== 'boolean') logging.enabled = true
  if (typeof logging.directory !== 'string') logging.directory = ''
  if (
    logging.level !== 'debug' &&
    logging.level !== 'info' &&
    logging.level !== 'warn' &&
    logging.level !== 'error'
  ) {
    logging.level = 'info'
  }
  general.logging = logging
  if (typeof general.restoreLastWorkspace !== 'boolean') {
    general.restoreLastWorkspace = true
  }
  const updates = { ...((general.updates as Record<string, unknown> | undefined) || {}) }
  if (typeof updates.autoCheck !== 'boolean') updates.autoCheck = true
  if (typeof updates.autoDownload !== 'boolean') updates.autoDownload = true
  general.updates = updates
  return { ...raw, general }
}

function sanitizeGithub(raw: Record<string, unknown>): Record<string, unknown> {
  const github = { ...((raw.github as Record<string, unknown> | undefined) || {}) }
  if (typeof github.host !== 'string' || !github.host.trim()) github.host = 'github.com'
  else github.host = String(github.host).replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (typeof github.tokenRef !== 'string') github.tokenRef = ''
  if (github.preferredProtocol !== 'ssh' && github.preferredProtocol !== 'https') {
    github.preferredProtocol = 'https'
  }
  if (typeof github.repository !== 'string') github.repository = ''
  if (typeof github.remoteName !== 'string' || !github.remoteName.trim()) {
    github.remoteName = 'origin'
  }
  if (typeof github.defaultBranch !== 'string' || !github.defaultBranch.trim()) {
    github.defaultBranch = 'main'
  }
  github.linked = Boolean(github.linked)
  return { ...raw, github }
}

function sanitizeEricServices(raw: Record<string, unknown>): Record<string, unknown> {
  const ericServices = { ...((raw.ericServices as Record<string, unknown> | undefined) || {}) }
  let apiBase =
    typeof ericServices.apiBase === 'string' && ericServices.apiBase.trim()
      ? ericServices.apiBase.trim()
      : 'https://www.ericservic.es'
  apiBase = apiBase.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(apiBase)) apiBase = `https://${apiBase}`
  ericServices.apiBase = apiBase
  if (typeof ericServices.tokenRef !== 'string') ericServices.tokenRef = ''
  ericServices.linked = Boolean(ericServices.linked)
  if (typeof ericServices.username !== 'string') ericServices.username = ''
  if (typeof ericServices.email !== 'string') ericServices.email = ''
  if (typeof ericServices.lastSyncedAt !== 'string') ericServices.lastSyncedAt = ''
  if (typeof ericServices.syncEnabled !== 'boolean') ericServices.syncEnabled = true
  const planRaw = String(ericServices.plan || 'free').toLowerCase()
  ericServices.plan = planRaw === 'pro' ? 'pro' : 'free'
  if (!ericServices.planLimits || typeof ericServices.planLimits !== 'object') {
    ericServices.planLimits = {}
  }
  return { ...raw, ericServices }
}

function sanitizeMcp(raw: Record<string, unknown>): Record<string, unknown> {
  const mcp = { ...((raw.mcp as Record<string, unknown> | undefined) || {}) }
  if (!Array.isArray(mcp.servers)) mcp.servers = []
  mcp.servers = (mcp.servers as Array<Record<string, unknown>>).map((s, i) => ({
    id: typeof s.id === 'string' && s.id ? s.id : `mcp-${i + 1}`,
    name: typeof s.name === 'string' && s.name ? s.name : `Server ${i + 1}`,
    enabled: Boolean(s.enabled),
    transport:
      s.transport === 'sse' || s.transport === 'http' || s.transport === 'stdio'
        ? s.transport
        : 'stdio',
    command: typeof s.command === 'string' ? s.command : '',
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    url: typeof s.url === 'string' ? s.url : '',
    env:
      s.env && typeof s.env === 'object' && !Array.isArray(s.env)
        ? Object.fromEntries(
            Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
          )
        : {},
    notes: typeof s.notes === 'string' ? s.notes : ''
  }))
  return { ...raw, mcp }
}

function buildResolvedSettings(workspacePath: string | null): AppSettings {
  const merged = sanitizeEditor(
    sanitizeEricServices(
      sanitizeGithub(
        sanitizeMcp(
          sanitizeGeneral(
            sanitizeLegacyModels(
              deepMerge(
                deepMerge(
                  getDefaults() as unknown as Record<string, unknown>,
                  getUserSettings() as Record<string, unknown>
                ),
                getEffectiveWorkspaceSettings(workspacePath) as Record<string, unknown>
              ) as Record<string, unknown>
            )
          )
        )
      )
    )
  )
  const agent = { ...(merged.agent as Record<string, unknown>) }
  const routing = { ...((agent.routing as Record<string, unknown>) || {}) }
  if (routing.fallbackAgentId === 'orchestrator') routing.fallbackAgentId = 'composer'
  if (!routing.routerModel) routing.routerModel = 'builtin:composer-lite'
  agent.routing = routing
  delete agent.subagents
  merged.agent = agent
  const parsed = SettingsSchema.safeParse(merged)
  if (parsed.success) return parsed.data
  // Never throw into IPC — a bad synced profile must not brick boot.
  return getDefaults()
}

export function getResolvedSettings(workspacePath: string | null): AppSettings {
  try {
    return buildResolvedSettings(workspacePath)
  } catch {
    return getDefaults()
  }
}

/**
 * Rewrite legacy connection `type` values (e.g. "openai") on disk so sync/login
 * never feeds invalid enums back through setSettings.
 */
export function migrateLegacyConnectionTypesInUserSettings(): void {
  const user = getUserSettings() as Record<string, unknown>
  const models = user.models as Record<string, unknown> | undefined
  if (!models || !Array.isArray(models.connections)) return
  let changed = false
  const connections = (models.connections as Array<Record<string, unknown>>).map((c) => {
    if (!c || typeof c !== 'object') return c
    const rawType = typeof c.type === 'string' ? c.type : ''
    if (rawType === 'builtin' || rawType === 'openai-compatible') return c
    changed = true
    const provider =
      typeof c.provider === 'string' && c.provider ? c.provider : rawType || 'custom'
    return { ...c, type: 'openai-compatible', provider }
  })
  if (!changed) return
  writeJson(userSettingsPath(), { ...user, models: { ...models, connections } })
}

export function setSettings(
  scope: SettingsScope,
  patch: SettingsPatch,
  workspacePath: string | null
): AppSettings {
  mkdirSync(userDataRoot(), { recursive: true })

  if (scope === 'user') {
    let next = deepMerge(getUserSettings() as Record<string, unknown>, patch as Record<string, unknown>)
    // Normalize model connection types before persisting (synced profiles may send "openai").
    if (next.models) next = sanitizeLegacyModels(next)
    writeJson(userSettingsPath(), next)
  } else {
    if (!workspacePath) {
      throw new Error('Workspace settings require an open workspace')
    }
    let next = deepMerge(
      getWorkspaceSettings(workspacePath) as Record<string, unknown>,
      patch as Record<string, unknown>
    )
    if (next.models) next = sanitizeLegacyModels(next)
    writeJson(workspaceSettingsPath(workspacePath), next)
    // Editing risky keys from Settings is an explicit user choice for this folder.
    if (riskyWorkspaceSettings(patch).length > 0) setWorkspaceTrusted(workspacePath, true)
  }

  return getResolvedSettings(workspacePath)
}

export function resetSettingKey(
  scope: SettingsScope,
  pathKeys: string[],
  workspacePath: string | null
): AppSettings {
  const current =
    scope === 'user' ? { ...getUserSettings() } : { ...getWorkspaceSettings(workspacePath) }

  let cursor: Record<string, unknown> = current as Record<string, unknown>
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const key = pathKeys[i]
    if (!cursor[key] || typeof cursor[key] !== 'object') {
      return getResolvedSettings(workspacePath)
    }
    cursor[key] = { ...(cursor[key] as Record<string, unknown>) }
    cursor = cursor[key] as Record<string, unknown>
  }
  delete cursor[pathKeys[pathKeys.length - 1]]

  if (scope === 'user') {
    writeJson(userSettingsPath(), current)
  } else {
    if (!workspacePath) throw new Error('Workspace settings require an open workspace')
    writeJson(workspaceSettingsPath(workspacePath), current)
  }
  return getResolvedSettings(workspacePath)
}

export function getLayeredSettings(workspacePath: string | null): {
  defaults: AppSettings
  user: SettingsPatch
  workspace: SettingsPatch
  resolved: AppSettings
} {
  return {
    defaults: getDefaults(),
    user: getUserSettings(),
    workspace: getWorkspaceSettings(workspacePath),
    resolved: getResolvedSettings(workspacePath)
  }
}

/** Migrate older user settings that still embed agent.subagents */
export function stripLegacySubagentsFromUserSettings(): void {
  const user = getUserSettings() as Record<string, unknown>
  const agent = user.agent as Record<string, unknown> | undefined
  if (!agent || !('subagents' in agent)) return
  const { subagents: _removed, ...rest } = agent
  writeJson(userSettingsPath(), { ...user, agent: rest })
}
