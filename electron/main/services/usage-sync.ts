import { ericServicesTokenRef, normalizeApiBase } from './ericservices'
import { getResolvedSettings } from './settings'
import { appState } from '../app-state'
import { getSecret } from '../ipc/shared'
import { logWarn } from './logger'
import {
  applyRemoteDayUsage,
  getLocalDayTotals,
  type DayUsageTotals
} from './usage-stats'

export type RemoteUsageDay = DayUsageTotals & {
  day: string
  updatedAt?: string | null
}

let remoteCache: RemoteUsageDay | null = null
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

function usageUrl(apiBase: string, query?: string): string {
  const root = `${normalizeApiBase(apiBase)}/api/eris/v1/usage.php`
  return query ? `${root}?${query}` : root
}

export function getRemoteUsageCache(): RemoteUsageDay | null {
  if (!remoteCache) return null
  if (remoteCache.day !== todayKey()) return null
  return remoteCache
}

/** Effective today totals: max(local, remote) so multi-device caps hold. */
export function getEffectiveTodayTotals(): DayUsageTotals & { day: string; synced: boolean } {
  const day = todayKey()
  const local = getLocalDayTotals(day)
  const remote = getRemoteUsageCache()
  if (!remote || remote.day !== day) {
    return { day, ...local, synced: false }
  }
  return {
    day,
    requests: Math.max(local.requests, remote.requests),
    inputTokens: Math.max(local.inputTokens, remote.inputTokens),
    outputTokens: Math.max(local.outputTokens, remote.outputTokens),
    cloudJobs: Math.max(local.cloudJobs, remote.cloudJobs),
    synced: true
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
      remoteCache = {
        day: data.day,
        requests: Number(data.usage.requests) || 0,
        inputTokens: Number(data.usage.inputTokens) || 0,
        outputTokens: Number(data.usage.outputTokens) || 0,
        cloudJobs: Number(data.usage.cloudJobs) || 0,
        updatedAt: data.usage.updatedAt
      }
      applyRemoteDayUsage(remoteCache)
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
    const res = await fetch(usageUrl(auth.apiBase, `day=${encodeURIComponent(todayKey())}`), {
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
      error?: string
    }
    if (!res.ok || data.ok === false || !data.usage || !data.day) {
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
    remoteCache = {
      day: data.day,
      requests: Number(data.usage.requests) || 0,
      inputTokens: Number(data.usage.inputTokens) || 0,
      outputTokens: Number(data.usage.outputTokens) || 0,
      cloudJobs: Number(data.usage.cloudJobs) || 0,
      updatedAt: data.usage.updatedAt
    }
    applyRemoteDayUsage(remoteCache)
    lastSyncedAt = new Date().toISOString()
    lastSyncError = null
    syncState = 'ok'
    return remoteCache
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
