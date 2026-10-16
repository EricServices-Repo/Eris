import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ericServicesTokenRef, normalizeApiBase } from './ericservices'
import { getResolvedSettings } from './settings'
import { userDataRoot } from './paths'
import { appState } from '../app-state'
import { getSecret } from '../ipc/shared'
import { logWarn } from './logger'
import {
  applyRemoteDayUsage,
  getLocalDayTotals,
  rollingDayKeys,
  sumDayTotals,
  USAGE_WINDOW_DAYS,
  type DayUsageTotals
} from './usage-stats'

export type RemoteUsageDay = DayUsageTotals & {
  day: string
  updatedAt?: string | null
}

let remoteDays: Record<string, RemoteUsageDay> = {}
let remoteDiskLoaded = false
let pendingDelta: DayUsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cloudJobs: 0
}
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false
let pullInFlight = false
type UsageSyncState = 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
let syncState: UsageSyncState = 'idle'
let lastSyncedAt: string | null = null
let lastSyncError: string | null = null

export type UsageSyncMeta = {
  state: UsageSyncState
  lastSyncedAt: string | null
  lastError: string | null
  authenticated: boolean
}

export function getUsageSyncMeta(): UsageSyncMeta {
  return {
    state: pullInFlight || flushing ? 'syncing' : syncState,
    lastSyncedAt,
    lastError: lastSyncError,
    authenticated: Boolean(authContext())
  }
}

function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function authContext(): { apiBase: string; token: string } | null {
  const settings = getResolvedSettings(appState.currentWorkspace)
  if (!settings.ericServices?.linked) return null
  const token = settings.ericServices.tokenRef
    ? getSecret(settings.ericServices.tokenRef)
    : getSecret(ericServicesTokenRef())
  if (!token) return null
  return {
    apiBase: normalizeApiBase(settings.ericServices.apiBase || 'https://www.ericservic.es'),
    token
  }
}

function usageCachePath(): string {
  return join(userDataRoot(), 'usage-remote.json')
}

function normalizeRemoteDay(raw: Partial<RemoteUsageDay> | null | undefined): RemoteUsageDay | null {
  if (!raw || typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null
  return {
    day: raw.day,
    requests: Number(raw.requests) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    cloudJobs: Number(raw.cloudJobs) || 0,
    updatedAt: raw.updatedAt
  }
}

function loadRemoteUsageDisk(): Record<string, RemoteUsageDay> {
  try {
    const path = usageCachePath()
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as
      | RemoteUsageDay
      | { days?: Record<string, RemoteUsageDay> }
    if (parsed && typeof (parsed as RemoteUsageDay).day === 'string') {
      const one = normalizeRemoteDay(parsed as RemoteUsageDay)
      return one ? { [one.day]: one } : {}
    }
    const days = (parsed as { days?: Record<string, RemoteUsageDay> }).days
    if (!days || typeof days !== 'object') return {}
    const out: Record<string, RemoteUsageDay> = {}
    for (const value of Object.values(days)) {
      const day = normalizeRemoteDay(value)
      if (day) out[day.day] = day
    }
    return out
  } catch {
    return {}
  }
}

function saveRemoteUsageDisk(): void {
  try {
    mkdirSync(userDataRoot(), { recursive: true })
    writeFileSync(usageCachePath(), JSON.stringify({ days: remoteDays }), 'utf8')
  } catch {
    /* best-effort */
  }
}

function rememberRemoteDays(days: RemoteUsageDay[]): void {
  if (days.length === 0) return
  remoteDiskLoaded = true
  for (const day of days) {
    remoteDays[day.day] = day
    applyRemoteDayUsage(day)
  }
  saveRemoteUsageDisk()
}

function ensureRemoteDisk(): void {
  if (remoteDiskLoaded) return
  remoteDiskLoaded = true
  try {
    remoteDays = loadRemoteUsageDisk()
  } catch {
    /* app path not ready */
  }
}

function usageUrl(apiBase: string, query?: string): string {
  const root = `${normalizeApiBase(apiBase)}/api/eris/v1/usage.php`
  return query ? `${root}?${query}` : root
}

export function getRemoteUsageCache(): RemoteUsageDay | null {
  ensureRemoteDisk()
  const today = remoteDays[todayKey()]
  return today || null
}

function maxDay(local: DayUsageTotals, remote: RemoteUsageDay | undefined): DayUsageTotals {
  if (!remote) return local
  return {
    requests: Math.max(local.requests, remote.requests),
    inputTokens: Math.max(local.inputTokens, remote.inputTokens),
    outputTokens: Math.max(local.outputTokens, remote.outputTokens),
    cloudJobs: Math.max(local.cloudJobs, remote.cloudJobs)
  }
}

/** Effective today totals: max(local, remote) so multi-device caps hold. */
export function getEffectiveTodayTotals(): DayUsageTotals & { day: string; synced: boolean } {
  const day = todayKey()
  const local = getLocalDayTotals(day)
  const remote = getRemoteUsageCache()
  if (!remote || remote.day !== day) {
    return { day, ...local, synced: false }
  }
  return { day, ...maxDay(local, remote), synced: true }
}

/** Sum of max(local, profile) across the rolling window. This is what plan limits use. */
export function getEffectiveWindowTotals(windowDays = USAGE_WINDOW_DAYS): DayUsageTotals & {
  from: string
  to: string
  days: number
  synced: boolean
} {
  ensureRemoteDisk()
  const keys = rollingDayKeys(windowDays)
  let synced = false
  const totals = sumDayTotals(
    keys.map((key) => {
      const remote = remoteDays[key]
      if (remote) synced = true
      return maxDay(getLocalDayTotals(key), remote)
    })
  )
  return {
    ...totals,
    from: keys[0] || todayKey(),
    to: keys[keys.length - 1] || todayKey(),
    days: keys.length,
    synced
  }
}

/** Profile-only totals inside the rolling window. Null when nothing has been pulled. */
export function getRemoteWindowTotals(windowDays = USAGE_WINDOW_DAYS): (DayUsageTotals & {
  from: string
  to: string
  days: number
}) | null {
  ensureRemoteDisk()
  const keys = rollingDayKeys(windowDays)
  const present = keys.map((key) => remoteDays[key]).filter((day): day is RemoteUsageDay => Boolean(day))
  if (present.length === 0) return null
  return {
    ...sumDayTotals(present),
    from: keys[0] || todayKey(),
    to: keys[keys.length - 1] || todayKey(),
    days: keys.length
  }
}

export function queueUsageDelta(delta: Partial<DayUsageTotals>): void {
  pendingDelta.requests += Math.max(0, Math.round(delta.requests || 0))
  pendingDelta.inputTokens += Math.max(0, Math.round(delta.inputTokens || 0))
  pendingDelta.outputTokens += Math.max(0, Math.round(delta.outputTokens || 0))
  pendingDelta.cloudJobs += Math.max(0, Math.round(delta.cloudJobs || 0))
  if (
    pendingDelta.requests === 0 &&
    pendingDelta.inputTokens === 0 &&
    pendingDelta.outputTokens === 0 &&
    pendingDelta.cloudJobs === 0
  ) {
    return
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushUsageDelta()
  }, 2_500)
  if (typeof flushTimer === 'object' && 'unref' in flushTimer) flushTimer.unref()
}

export async function flushUsageDelta(): Promise<void> {
  if (flushing) return
  const auth = authContext()
  if (!auth) {
    pendingDelta = { requests: 0, inputTokens: 0, outputTokens: 0, cloudJobs: 0 }
    return
  }
  const delta = { ...pendingDelta }
  if (
    delta.requests === 0 &&
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cloudJobs === 0
  ) {
    return
  }
  pendingDelta = { requests: 0, inputTokens: 0, outputTokens: 0, cloudJobs: 0 }
  flushing = true
  try {
    const res = await fetch(usageUrl(auth.apiBase), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'X-Eris-Client': 'eris-desktop'
      },
      body: JSON.stringify({
        day: todayKey(),
        delta,
        source: 'eris-desktop'
      }),
      signal: AbortSignal.timeout(12_000)
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      usage?: RemoteUsageDay
      day?: string
    }
    if (!res.ok || data.ok === false) {
      // Re-queue so a blip does not drop metering
      pendingDelta.requests += delta.requests
      pendingDelta.inputTokens += delta.inputTokens
      pendingDelta.outputTokens += delta.outputTokens
      pendingDelta.cloudJobs += delta.cloudJobs
      logWarn('Profile usage push failed', {
        status: res.status,
        error: data.error || res.statusText
      })
      return
    }
    if (data.usage && data.day) {
      const day = normalizeRemoteDay({ ...data.usage, day: data.day })
      if (day) rememberRemoteDays([day])
    }
  } catch (err) {
    pendingDelta.requests += delta.requests
    pendingDelta.inputTokens += delta.inputTokens
    pendingDelta.outputTokens += delta.outputTokens
    pendingDelta.cloudJobs += delta.cloudJobs
    logWarn('Profile usage push error', {
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    flushing = false
  }
}

/** Pull profile usage into local cache (call on login / Usage panel refresh). */
export async function pullUsageFromProfile(): Promise<RemoteUsageDay | null> {
  const auth = authContext()
  if (!auth) {
    syncState = 'idle'
    lastSyncError = null
    return null
  }
  pullInFlight = true
  syncState = 'syncing'
  try {
    const res = await fetch(
      usageUrl(
        auth.apiBase,
        `day=${encodeURIComponent(todayKey())}&days=${USAGE_WINDOW_DAYS}`
      ),
      {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'X-Eris-Client': 'eris-desktop'
      },
      signal: AbortSignal.timeout(10_000)
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      day?: string
      usage?: RemoteUsageDay
      days?: RemoteUsageDay[]
      error?: string
    }
    const pulled: RemoteUsageDay[] = []
    if (Array.isArray(data.days)) {
      for (const entry of data.days) {
        const day = normalizeRemoteDay(entry)
        if (day) pulled.push(day)
      }
    }
    if (data.usage && data.day && !pulled.some((entry) => entry.day === data.day)) {
      const day = normalizeRemoteDay({ ...data.usage, day: data.day })
      if (day) pulled.push(day)
    }
    if (!res.ok || data.ok === false || pulled.length === 0) {
      const errMsg = data.error || res.statusText || `HTTP ${res.status}`
      if (res.status === 404) {
        syncState = 'offline'
        lastSyncError = 'Profile usage API not deployed yet (usage.php)'
      } else {
        syncState = 'error'
        lastSyncError = errMsg
        logWarn('Profile usage pull failed', { status: res.status, error: errMsg })
      }
      return null
    }
    rememberRemoteDays(pulled)
    lastSyncedAt = new Date().toISOString()
    lastSyncError = null
    syncState = 'ok'
    return getRemoteUsageCache()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    syncState = /abort|timeout|network|fetch failed|ENOTFOUND|ECONN/i.test(message)
      ? 'offline'
      : 'error'
    lastSyncError = message
    logWarn('Profile usage pull error', { error: message })
    return null
  } finally {
    pullInFlight = false
  }
}
