import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { audit } from './observe.js'

/**
 * Settings EricServic.es may push/pull onto a Cloud Agent.
 * Secrets (llmKey) are stored but never returned on public status.
 */
export type RemoteAgentSettings = {
  maxParallel?: number
  maxThreads?: number
  contextSize?: number
  warmOnStart?: boolean
  freeJobsPerDay?: number
  maxConcurrentFree?: number
  maxConcurrentPro?: number
  maxQueue?: number
  maxSteps?: number
  maxFiles?: number
  publicBaseUrl?: string
  /** Remote OpenAI-compatible base; empty string clears */
  llmBase?: string
  llmModel?: string
  /** Stored locally; never echoed in public JSON */
  llmKey?: string
  allowAnonymous?: boolean
  displayName?: string
}

export type RemoteConfigFile = {
  revision: number
  updatedAt: string
  source: 'pull' | 'push' | 'enroll' | 'local'
  settings: RemoteAgentSettings
}

function remotePath(): string {
  return join(config.dataDir, 'remote-config.json')
}

let current: RemoteConfigFile | null = null

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

/** Sanitize inbound settings from the platform. */
export function sanitizeRemoteSettings(raw: unknown): RemoteAgentSettings {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const out: RemoteAgentSettings = {}

  if (o.maxParallel != null) out.maxParallel = clampInt(o.maxParallel, 1, 8, config.maxParallel)
  if (o.maxThreads != null) out.maxThreads = clampInt(o.maxThreads, 0, 64, config.maxThreads)
  if (o.contextSize != null) out.contextSize = clampInt(o.contextSize, 512, 32768, config.contextSize)
  if (o.warmOnStart != null) out.warmOnStart = Boolean(o.warmOnStart)
  if (o.freeJobsPerDay != null)
    out.freeJobsPerDay = clampInt(o.freeJobsPerDay, 1, 10_000, config.freeJobsPerDay)
  if (o.maxConcurrentFree != null)
    out.maxConcurrentFree = clampInt(o.maxConcurrentFree, 1, 4, config.maxConcurrentFree)
  if (o.maxConcurrentPro != null)
    out.maxConcurrentPro = clampInt(o.maxConcurrentPro, 1, 8, config.maxConcurrentPro)
  if (o.maxQueue != null) out.maxQueue = clampInt(o.maxQueue, 10, 500, config.maxQueue)
  if (o.maxSteps != null) out.maxSteps = clampInt(o.maxSteps, 8, 80, config.maxSteps)
  if (o.maxFiles != null) out.maxFiles = clampInt(o.maxFiles, 1, 800, config.maxFiles)
  if (typeof o.publicBaseUrl === 'string') {
    out.publicBaseUrl = o.publicBaseUrl.trim().replace(/\/+$/, '').slice(0, 500)
  }
  if (typeof o.llmBase === 'string') {
    out.llmBase = o.llmBase.trim().replace(/\/+$/, '').slice(0, 500)
  }
  if (typeof o.llmModel === 'string') out.llmModel = o.llmModel.trim().slice(0, 120)
  if (typeof o.llmKey === 'string') out.llmKey = o.llmKey.slice(0, 2000)
  if (o.allowAnonymous != null) out.allowAnonymous = Boolean(o.allowAnonymous)
  if (typeof o.displayName === 'string') out.displayName = o.displayName.trim().slice(0, 80)

  // CPU hosts: never allow remote to raise parallel above 1
  if (config.gpu === 'false' && out.maxParallel != null) {
    out.maxParallel = Math.min(1, out.maxParallel)
  }
  return out
}

/** Apply sanitized settings onto the live `config` object (env remains the floor for boot). */
export function applyRemoteSettings(settings: RemoteAgentSettings): string[] {
  const changed: string[] = []
  const set = <K extends keyof typeof config>(key: K, value: (typeof config)[K], label: string) => {
    if (config[key] === value) return
    ;(config as Record<string, unknown>)[key as string] = value
    changed.push(label)
  }

  if (settings.maxParallel != null) set('maxParallel', settings.maxParallel, 'maxParallel')
  if (settings.maxThreads != null) set('maxThreads', settings.maxThreads, 'maxThreads')
  if (settings.contextSize != null) set('contextSize', settings.contextSize, 'contextSize')
  if (settings.warmOnStart != null) set('warmOnStart', settings.warmOnStart, 'warmOnStart')
  if (settings.freeJobsPerDay != null) set('freeJobsPerDay', settings.freeJobsPerDay, 'freeJobsPerDay')
  if (settings.maxConcurrentFree != null)
    set('maxConcurrentFree', settings.maxConcurrentFree, 'maxConcurrentFree')
  if (settings.maxConcurrentPro != null)
    set('maxConcurrentPro', settings.maxConcurrentPro, 'maxConcurrentPro')
  if (settings.maxQueue != null) set('maxQueue', settings.maxQueue, 'maxQueue')
  if (settings.maxSteps != null) set('maxSteps', settings.maxSteps, 'maxSteps')
  if (settings.maxFiles != null) set('maxFiles', settings.maxFiles, 'maxFiles')
  if (settings.publicBaseUrl != null && settings.publicBaseUrl)
    set('publicBaseUrl', settings.publicBaseUrl, 'publicBaseUrl')
  if (settings.llmBase != null) set('llmBase', settings.llmBase, 'llmBase')
  if (settings.llmModel != null && settings.llmModel) set('llmModel', settings.llmModel, 'llmModel')
  if (settings.llmKey != null) set('llmKey', settings.llmKey, 'llmKey')
  if (settings.allowAnonymous != null) set('allowAnonymous', settings.allowAnonymous, 'allowAnonymous')

  return changed
}

export function loadRemoteConfigFromDisk(): RemoteConfigFile | null {
  try {
    if (!existsSync(remotePath())) return null
    const raw = JSON.parse(readFileSync(remotePath(), 'utf8')) as RemoteConfigFile
    if (!raw || typeof raw !== 'object') return null
    const settings = sanitizeRemoteSettings(raw.settings || {})
    current = {
      revision: Math.max(0, Number(raw.revision) || 0),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      source: raw.source || 'local',
      settings
    }
    applyRemoteSettings(settings)
    return current
  } catch {
    return null
  }
}

export function getRemoteConfig(): RemoteConfigFile | null {
  return current
}

export function getConfigRevision(): number {
  return current?.revision ?? 0
}

/** Public-safe view (no llmKey). */
export function publicRemoteConfig(): Record<string, unknown> | null {
  if (!current) return null
  const { llmKey: _k, ...safe } = current.settings
  return {
    revision: current.revision,
    updatedAt: current.updatedAt,
    source: current.source,
    settings: safe,
    displayName: current.settings.displayName || null
  }
}

export function persistRemoteConfig(
  revision: number,
  settings: RemoteAgentSettings,
  source: RemoteConfigFile['source']
): RemoteConfigFile {
  const sanitized = sanitizeRemoteSettings(settings)
  const prevKey = current?.settings.llmKey
  if (sanitized.llmKey === undefined && prevKey) sanitized.llmKey = prevKey

  const changed = applyRemoteSettings(sanitized)
  current = {
    revision: Math.max(0, Math.floor(revision)),
    updatedAt: new Date().toISOString(),
    source,
    settings: sanitized
  }
  try {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(remotePath(), JSON.stringify(current, null, 2), 'utf8')
  } catch {
    // ignore disk errors
  }
  if (changed.length) {
    audit('remote_config_applied', {
      revision: current.revision,
      source,
      changed
    })
  }
  return current
}
