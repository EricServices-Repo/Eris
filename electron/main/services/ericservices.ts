import type { AppSettings, McpServerConfig, SettingsPatch } from '../../../src/shared/settings-schema'
import { parseErisPlanFromProfile, type ErisPlanId } from '../../../src/shared/eris-plan'
import {
  exportUserSkillsForSync,
  importUserSkillsFromSync,
  type SyncableSkill
} from './skills'

export interface EricServicesProfile {
  username: string
  email: string
  isAdmin?: boolean
  accountUrl?: string
  /** Set by www.ericservic.es admin (Free / Pro pulldown). */
  erisPlan?: 'free' | 'pro' | string
  plan?: string
  eris_plan?: string
  /** Optional Free-tier overrides from Control Hub. */
  erisLimits?: {
    dailyRequests?: number | null
    dailyTokens?: number | null
    cloudJobsPerDay?: number | null
  }
  eris_limits?: EricServicesProfile['erisLimits']
}

export interface EricServicesStatus {
  ok: boolean
  error?: string
  linked: boolean
  hasToken: boolean
  /** Local link looks valid but /me rejected the device token — prompt re-login. */
  needsReauth?: boolean
  apiBase: string
  username: string
  email: string
  lastSyncedAt: string
  syncEnabled: boolean
  /** Cached plan from Control Hub (free | pro). */
  plan: 'free' | 'pro'
  profile?: EricServicesProfile | null
  remoteUpdatedAt?: string | null
}

/** Extended profile payload (settings + skills). Website may store as opaque JSON. */
export interface ErisProfileBundle {
  version: 1
  settings: SettingsPatch
  userSkills: SyncableSkill[]
}

export type ErisSyncEnvelope = {
  settings: SettingsPatch
  bundle?: ErisProfileBundle
  clientUpdatedAt?: string
}

const TOKEN_REF = 'ericServices.token'

export function normalizeApiBase(base: string): string {
  let b = (base || 'https://www.ericservic.es').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`
  return b
}

function apiRoot(apiBase: string): string {
  return `${normalizeApiBase(apiBase)}/api/eris/v1`
}

async function erisFetch(
  apiBase: string,
  path: string,
  init: RequestInit & { token?: string | null } = {}
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const { token, ...rest } = init
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(rest.headers as Record<string, string> | undefined)
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (rest.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(`${apiRoot(apiBase)}${path}`, {
      ...rest,
      headers
    })
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {},
      error: err instanceof Error ? err.message : 'Network error reaching EricServic.es'
    }
  }

  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    if (res.status === 404) {
      return {
        ok: false,
        status: res.status,
        data: {},
        error:
          'Eris API not found on this site yet. Deploy /api/eris/v1 and run sql/migrations/20261009_eris_profile.sql'
      }
    }
    return {
      ok: false,
      status: res.status,
      data: {},
      error: `Unexpected response from EricServic.es (${res.status})`
    }
  }

  if (!res.ok || data.ok === false) {
    return {
      ok: false,
      status: res.status,
      data,
      error: typeof data.error === 'string' ? data.error : `Request failed (${res.status})`
    }
  }

  return { ok: true, status: res.status, data }
}

function sanitizeMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    command: s.command,
    args: [...(s.args || [])],
    url: s.url,
    // Keep env keys as placeholders; never sync secret values
    env: Object.fromEntries(Object.keys(s.env || {}).map((k) => [k, ''])),
    notes: s.notes || ''
  }))
}

function sanitizeLanguageServers(
  servers: AppSettings['intelligence']['languageServers']
): AppSettings['intelligence']['languageServers'] {
  return (servers || []).map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    languageId: s.languageId,
    extensions: [...(s.extensions || [])],
    command: s.command,
    args: [...(s.args || [])]
  }))
}

/**
 * User-preference settings safe for EricServic.es profile sync.
 * Excludes secrets, machine paths, account session state, and workspace-only git fields.
 */
export function buildSyncableSettings(settings: AppSettings): SettingsPatch {
  return {
    editor: {
      fontSize: settings.editor.fontSize,
      tabSize: settings.editor.tabSize,
      theme: settings.editor.theme,
      inlineSuggest: settings.editor.inlineSuggest,
      chatFont: settings.editor.chatFont
    },
    general: {
      restoreLastWorkspace: settings.general.restoreLastWorkspace,
      updates: {
        autoCheck: settings.general.updates?.autoCheck !== false,
        autoDownload: settings.general.updates?.autoDownload !== false,
        channel: settings.general.updates?.channel === 'beta' ? 'beta' : 'stable'
      },
      logging: {
        enabled: settings.general.logging.enabled,
        // directory is machine-local — never sync
        level: settings.general.logging.level
      },
      telemetry: {
        agentOutcomes: settings.general.telemetry?.agentOutcomes === true
      }
    },
    agent: {
      systemPrompt: settings.agent.systemPrompt,
      includeOpenFiles: settings.agent.includeOpenFiles,
      maxHistoryMessages: settings.agent.maxHistoryMessages,
      autoKeepDiffs: settings.agent.autoKeepDiffs,
      commandApproval: settings.agent.commandApproval,
      allowedCommands: [...(settings.agent.allowedCommands || [])],
      constrainLocalToolCalls: settings.agent.constrainLocalToolCalls !== false,
      routing: {
        enabled: settings.agent.routing.enabled,
        mode: settings.agent.routing.mode,
        useLlmRouter: settings.agent.routing.useLlmRouter,
        fallbackAgentId: settings.agent.routing.fallbackAgentId,
        routerModel: settings.agent.routing.routerModel
      }
    },
    models: {
      defaultModel: settings.models.defaultModel,
      temperature: settings.models.temperature,
      contextWindow: settings.models.contextWindow,
      preferEgpu: settings.models.preferEgpu !== false,
      connections: (settings.models.connections || []).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        provider: c.provider,
        enabled: c.enabled,
        baseUrl: c.baseUrl,
        apiKeyRef: '',
        models: [...(c.models || [])]
      }))
    },
    intelligence: {
      embeddingProvider: settings.intelligence.embeddingProvider,
      embeddingModel: settings.intelligence.embeddingModel,
      languageServers: sanitizeLanguageServers(settings.intelligence.languageServers)
    },
    evals: {
      useScoresForRouting: settings.evals.useScoresForRouting,
      minRuns: settings.evals.minRuns
      // allowUnsafeCommands stays local — safety policy per machine
    },
    backgroundAgents: {
      maxParallel: settings.backgroundAgents.maxParallel,
      linkNodeModules: settings.backgroundAgents.linkNodeModules
    },
    mcp: {
      servers: sanitizeMcpServers(settings.mcp?.servers || [])
    },
    github: {
      host: settings.github.host || 'github.com',
      preferredProtocol: settings.github.preferredProtocol || 'https',
      remoteName: settings.github.remoteName || 'origin',
      defaultBranch: settings.github.defaultBranch || 'main'
      // tokenRef / repository / linked stay local or workspace-scoped
    }
  }
}

/**
 * Apply a pulled profile patch while rehydrating secrets that never leave the device.
 */
export function mergePulledUserSettings(
  remote: SettingsPatch,
  local: AppSettings
): SettingsPatch {
  const patch: SettingsPatch = { ...remote }
  if (remote.mcp?.servers) {
    const localById = new Map((local.mcp?.servers || []).map((s) => [s.id, s]))
    patch.mcp = {
      servers: remote.mcp.servers.map((rs) => {
        if (!rs || typeof rs !== 'object' || !('id' in rs)) return rs as never
        const id = String((rs as { id: string }).id)
        const loc = localById.get(id)
        if (!loc) return rs as never
        const env = { ...((rs as { env?: Record<string, string> }).env || {}) }
        for (const [k, v] of Object.entries(loc.env || {})) {
          if (!env[k]) env[k] = v
        }
        return { ...(rs as object), env } as never
      })
    }
  }
  if (remote.models?.connections) {
    const localById = new Map((local.models?.connections || []).map((c) => [c.id, c]))
    patch.models = {
      ...(patch.models || {}),
      connections: remote.models.connections.map((rc) => {
        if (!rc || typeof rc !== 'object' || !('id' in rc)) return rc as never
        const id = String((rc as { id: string }).id)
        const loc = localById.get(id)
        if (!loc?.apiKeyRef) return { ...(rc as object), apiKeyRef: '' } as never
        return { ...(rc as object), apiKeyRef: loc.apiKeyRef } as never
      })
    }
  }
  if (remote.intelligence?.languageServers) {
    const localById = new Map(
      (local.intelligence?.languageServers || []).map((s) => [s.id, s])
    )
    patch.intelligence = {
      ...(patch.intelligence || {}),
      languageServers: remote.intelligence.languageServers.map((rs) => {
        if (!rs || typeof rs !== 'object' || !('id' in rs)) return rs as never
        const id = String((rs as { id: string }).id)
        const loc = localById.get(id)
        const remoteCmd = String((rs as { command?: string }).command || '').trim()
        if (remoteCmd || !loc) return rs as never
        return {
          ...(rs as object),
          command: loc.command,
          args: [...(loc.args || [])]
        } as never
      })
    }
  }
  // Never let remote wipe local secrets / account / workspace git link
  delete (patch as { ericServices?: unknown }).ericServices
  if (patch.github) {
    const g = { ...patch.github } as Record<string, unknown>
    delete g.tokenRef
    delete g.repository
    delete g.linked
    patch.github = g as SettingsPatch['github']
  }
  if (patch.general?.logging) {
    const logging = { ...patch.general.logging } as Record<string, unknown>
    delete logging.directory
    patch.general = {
      ...patch.general,
      logging: logging as AppSettings['general']['logging']
    }
  }
  if (patch.evals) {
    const evals = { ...patch.evals } as Record<string, unknown>
    delete evals.allowUnsafeCommands
    patch.evals = evals as SettingsPatch['evals']
  }
  return patch
}

/** Full profile envelope for push (settings + user skills). */
export function buildProfileBundle(settings: AppSettings): ErisProfileBundle {
  return {
    version: 1,
    settings: buildSyncableSettings(settings),
    userSkills: exportUserSkillsForSync()
  }
}

export function applyProfileBundle(bundle: ErisProfileBundle | null | undefined): {
  settings: SettingsPatch | null
  skillsImported: number
} {
  if (!bundle || typeof bundle !== 'object') {
    return { settings: null, skillsImported: 0 }
  }
  const settings =
    bundle.settings && typeof bundle.settings === 'object' ? bundle.settings : null
  let skillsImported = 0
  if (Array.isArray(bundle.userSkills) && bundle.userSkills.length > 0) {
    skillsImported = importUserSkillsFromSync(bundle.userSkills).imported
  }
  return { settings, skillsImported }
}

function parseBundleFromData(data: Record<string, unknown>): ErisProfileBundle | null {
  const raw = data.bundle
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const b = raw as Partial<ErisProfileBundle>
    return {
      version: 1,
      settings: (b.settings as SettingsPatch) || (data.settings as SettingsPatch) || {},
      userSkills: Array.isArray(b.userSkills) ? (b.userSkills as SyncableSkill[]) : []
    }
  }
  // Legacy: settings only
  if (data.settings && typeof data.settings === 'object') {
    return {
      version: 1,
      settings: data.settings as SettingsPatch,
      userSkills: []
    }
  }
  return null
}

export async function ericServicesLogin(
  apiBase: string,
  username: string,
  password: string,
  deviceName = 'Eris'
): Promise<{ ok: boolean; error?: string; token?: string; profile?: EricServicesProfile }> {
  const result = await erisFetch(apiBase, '/auth/login.php', {
    method: 'POST',
    body: JSON.stringify({ username, password, deviceName })
  })
  if (!result.ok) return { ok: false, error: result.error }
  const profile = result.data.profile as EricServicesProfile | undefined
  const token = typeof result.data.token === 'string' ? result.data.token : undefined
  if (!token) return { ok: false, error: 'Login succeeded but no token was returned' }
  return { ok: true, token, profile }
}

export async function ericServicesLogout(
  apiBase: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  const result = await erisFetch(apiBase, '/auth/logout.php', {
    method: 'POST',
    token,
    body: '{}'
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true }
}

export async function ericServicesFetchMe(
  apiBase: string,
  token: string
): Promise<{ ok: boolean; error?: string; status?: number; profile?: EricServicesProfile }> {
  const result = await erisFetch(apiBase, '/me.php', { method: 'GET', token })
  if (!result.ok) return { ok: false, error: result.error, status: result.status }
  return { ok: true, status: result.status, profile: result.data.profile as EricServicesProfile }
}

/** True when /me failed because the device token is missing, revoked, or expired. */
export function isEricServicesAuthFailure(error?: string, status?: number): boolean {
  if (status === 401 || status === 403) return true
  const msg = String(error || '').toLowerCase()
  return /unauthor|forbidden|invalid.?token|expired|not.?authenticated|revoked|sign.?in/i.test(msg)
}

export async function ericServicesPullSettings(
  apiBase: string,
  token: string
): Promise<{
  ok: boolean
  error?: string
  settings?: SettingsPatch | null
  bundle?: ErisProfileBundle | null
  updatedAt?: string | null
}> {
  const result = await erisFetch(apiBase, '/settings.php', { method: 'GET', token })
  if (!result.ok) return { ok: false, error: result.error }
  const bundle = parseBundleFromData(result.data)
  return {
    ok: true,
    settings: bundle?.settings ?? ((result.data.settings as SettingsPatch | null) ?? null),
    bundle,
    updatedAt: (result.data.updatedAt as string | null) ?? null
  }
}

export async function ericServicesPushSettings(
  apiBase: string,
  token: string,
  settings: SettingsPatch,
  clientUpdatedAt?: string | null,
  bundle?: ErisProfileBundle | null
): Promise<{
  ok: boolean
  error?: string
  settings?: SettingsPatch | null
  bundle?: ErisProfileBundle | null
  updatedAt?: string | null
}> {
  const payload: ErisSyncEnvelope = {
    settings,
    clientUpdatedAt: clientUpdatedAt || undefined,
    bundle: bundle || {
      version: 1,
      settings,
      userSkills: []
    }
  }
  const result = await erisFetch(apiBase, '/settings.php', {
    method: 'PUT',
    token,
    body: JSON.stringify(payload)
  })
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      settings: (result.data.settings as SettingsPatch | null) ?? null,
      bundle: parseBundleFromData(result.data),
      updatedAt: (result.data.updatedAt as string | null) ?? null
    }
  }
  return {
    ok: true,
    settings: (result.data.settings as SettingsPatch | null) ?? null,
    bundle: parseBundleFromData(result.data),
    updatedAt: (result.data.updatedAt as string | null) ?? null
  }
}

export function ericServicesTokenRef(): string {
  return TOKEN_REF
}

/** Linked account + stored device token — required for Cloud Agents. */
export function isEricServicesAuthenticated(
  settings: AppSettings,
  token: string | null | undefined
): boolean {
  return Boolean(settings.ericServices?.linked && token)
}

export function planPatchFromProfile(
  profile: EricServicesProfile | null | undefined
): { plan: ErisPlanId; planLimits: AppSettings['ericServices']['planLimits'] } {
  const parsed = parseErisPlanFromProfile(profile)
  return {
    plan: parsed.plan,
    planLimits:
      parsed.plan === 'pro'
        ? {}
        : {
            dailyRequests: parsed.limits.dailyRequests,
            dailyTokens: parsed.limits.dailyTokens,
            cloudJobsPerDay: parsed.limits.cloudJobsPerDay
          }
  }
}

export function buildEricServicesStatus(
  settings: AppSettings,
  hasToken: boolean,
  extras?: Partial<EricServicesStatus>
): EricServicesStatus {
  const plan: ErisPlanId = settings.ericServices.plan === 'pro' ? 'pro' : 'free'
  return {
    ok: true,
    linked: Boolean(settings.ericServices.linked && hasToken),
    hasToken,
    apiBase: normalizeApiBase(settings.ericServices.apiBase),
    username: settings.ericServices.username || '',
    email: settings.ericServices.email || '',
    lastSyncedAt: settings.ericServices.lastSyncedAt || '',
    syncEnabled: settings.ericServices.syncEnabled !== false,
    plan,
    profile: settings.ericServices.username
      ? {
          username: settings.ericServices.username,
          email: settings.ericServices.email || '',
          erisPlan: plan
        }
      : null,
    ...extras
  }
}
