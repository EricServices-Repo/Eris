import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import type { AuthContext } from './auth.js'
import type { JobStore } from './job-store.js'

const USAGE_WINDOW_DAYS = 30

type UsageFile = { version: 2; days: Record<string, Record<string, number>> }

function usagePath(): string {
  return join(config.dataDir, 'usage-daily.json')
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function rollingKeys(count = USAGE_WINDOW_DAYS): string[] {
  const keys: string[] = []
  const end = new Date()
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i))
    keys.push(d.toISOString().slice(0, 10))
  }
  return keys
}

function loadUsage(): UsageFile {
  const empty: UsageFile = { version: 2, days: {} }
  try {
    if (!existsSync(usagePath())) return empty
    const raw = JSON.parse(readFileSync(usagePath(), 'utf8')) as {
      version?: number
      day?: string
      jobs?: Record<string, number>
      days?: Record<string, Record<string, number>>
    }
    if (raw && raw.days && typeof raw.days === 'object') {
      return { version: 2, days: raw.days }
    }
    if (raw?.day && raw.jobs) return { version: 2, days: { [raw.day]: raw.jobs } }
    return empty
  } catch {
    return empty
  }
}

function saveUsage(u: UsageFile): void {
  const keep = new Set(rollingKeys(90))
  for (const key of Object.keys(u.days)) {
    if (!keep.has(key)) delete u.days[key]
  }
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(usagePath(), JSON.stringify(u, null, 2), 'utf8')
}

function jobsForOwner(file: UsageFile, owner: string, keys: string[]): number {
  let n = 0
  for (const key of keys) n += Number(file.days[key]?.[owner]) || 0
  return n
}

export async function assertCanEnqueue(
  auth: AuthContext,
  store: JobStore
): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = auth.owner
  const running = store
    .list(500)
    .filter((j) => j.ownerId === owner && (j.status === 'running' || j.status === 'queued')).length
  const maxConcurrent =
    auth.plan === 'pro' ? config.maxConcurrentPro : config.maxConcurrentFree
  if (running >= maxConcurrent) {
    return {
      ok: false,
      error: `Too many active Cloud Agent jobs for ${auth.plan} (${running}/${maxConcurrent}). Wait for one to finish.`
    }
  }

  const queuedTotal = store.counts().queued
  if (queuedTotal >= config.maxQueue) {
    return {
      ok: false,
      error: `Cloud Agent queue is full (${queuedTotal}/${config.maxQueue}). Try again shortly.`
    }
  }

  if (auth.plan === 'free') {
    const usage = loadUsage()
    const keys = rollingKeys()
    const localUsed = jobsForOwner(usage, owner, keys)
    const remote = await remoteCloudJobsWindow(auth, keys)
    const cap = remote?.limit ?? config.freeJobsPerDay
    const used = Math.max(localUsed, remote?.used ?? 0)
    if (remote?.exhausted || (cap != null && used >= cap)) {
      return {
        ok: false,
        error: `Free plan Cloud Agent limit reached for the last ${USAGE_WINDOW_DAYS} days (${cap ?? config.freeJobsPerDay}). Upgrade to Pro.`
      }
    }
  }
  return { ok: true }
}

export function recordEnqueue(auth: AuthContext): void {
  if (auth.plan === 'pro') return
  const usage = loadUsage()
  const day = todayKey()
  const jobs = usage.days[day] || {}
  jobs[auth.owner] = (jobs[auth.owner] || 0) + 1
  usage.days[day] = jobs
  saveUsage(usage)
  void reportCloudJobToProfile(auth)
}

/** Push +1 cloud job to the user's EricServic.es profile (best-effort). */
async function reportCloudJobToProfile(auth: AuthContext): Promise<void> {
  if (!auth.token) return
  const day = todayKey()
  const url = `${config.erisApiBase.replace(/\/+$/, '')}/usage.php`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'User-Agent': 'eris-cloud-agent',
        'X-Eris-Client': 'eris-cloud-agent'
      },
      body: JSON.stringify({
        day,
        delta: { cloudJobs: 1, requests: 0, inputTokens: 0, outputTokens: 0 },
        source: 'cloud-agent'
      }),
      signal: AbortSignal.timeout(8_000)
    })
    if (!res.ok) {
      // Soft-fail — local worker cap still applies
      return
    }
  } catch {
    // ignore network errors
  }
}

/**
 * Prefer profile cloudJobs when available so Free caps apply across devices/agents.
 * Sums the rolling window when the profile returns recent days.
 */
export async function remoteCloudJobsWindow(
  auth: AuthContext,
  keys: string[]
): Promise<{ used: number; limit: number | null; exhausted: boolean } | null> {
  if (!auth.token) return null
  const url = `${config.erisApiBase.replace(/\/+$/, '')}/usage.php?day=${encodeURIComponent(todayKey())}&days=${USAGE_WINDOW_DAYS}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'User-Agent': 'eris-cloud-agent'
      },
      signal: AbortSignal.timeout(6_000)
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      usage?: { cloudJobs?: number; day?: string }
      day?: string
      days?: Array<{ day?: string; cloudJobs?: number }>
      limits?: { cloudJobsPerDay?: number | null }
      allowance?: { cloudJobs?: { used?: number; limit?: number | null; exhausted?: boolean } }
    }
    if (!res.ok || data.ok === false) return null
    const allowance = data.allowance?.cloudJobs
    if (allowance && typeof allowance.used === 'number') {
      const limit = allowance.limit === null || typeof allowance.limit === 'number' ? allowance.limit ?? null : null
      return { used: allowance.used, limit, exhausted: Boolean(allowance.exhausted) }
    }
    const wanted = new Set(keys)
    let n = 0
    if (Array.isArray(data.days) && data.days.length > 0) {
      for (const entry of data.days) {
        if (!entry?.day || !wanted.has(entry.day)) continue
        const jobs = Number(entry.cloudJobs)
        if (Number.isFinite(jobs)) n += Math.max(0, Math.floor(jobs))
      }
    } else {
      const todayJobs = Number(data.usage?.cloudJobs)
      n = Number.isFinite(todayJobs) ? Math.max(0, Math.floor(todayJobs)) : 0
    }
    const limit =
      data.limits && (data.limits.cloudJobsPerDay === null || typeof data.limits.cloudJobsPerDay === 'number')
        ? data.limits.cloudJobsPerDay ?? null
        : config.freeJobsPerDay
    return { used: n, limit, exhausted: limit != null && n >= limit }
  } catch {
    return null
  }
}

/** Mask owner for the public :80 status page (no full emails/usernames). */
export function maskOwner(owner: string): string {
  const s = String(owner || '').trim() || 'anonymous'
  if (s === 'anonymous') return 'anonymous'
  if (s.length <= 4) return s[0] + '…'
  return s.slice(0, 2) + '…' + s.slice(-2)
}

/**
 * Free-plan enqueue usage. Today is UTC; the cap is the last 30 UTC days.
 * Safe for the public status page.
 */
export function getUsageOverview(): {
  day: string
  freeJobsPerDay: number
  freeEnqueuesToday: number
  freeEnqueuesWindow: number
  freeUsersToday: number
  freeUsersWindow: number
  freeUsersAtCap: number
  topFreeUsers: Array<{ owner: string; jobs: number; atCap: boolean }>
} {
  const usage = loadUsage()
  const freeJobsPerDay = config.freeJobsPerDay
  const today = todayKey()
  const windowKeys = rollingKeys()
  const owners = new Set<string>()
  for (const key of windowKeys) {
    for (const owner of Object.keys(usage.days[key] || {})) owners.add(owner)
  }
  const entries = [...owners]
    .map((owner) => {
      const n = jobsForOwner(usage, owner, windowKeys)
      return { owner: maskOwner(owner), jobs: n, atCap: n >= freeJobsPerDay }
    })
    .filter((e) => e.jobs > 0)
    .sort((a, b) => b.jobs - a.jobs)
  const todayJobs = usage.days[today] || {}
  const freeEnqueuesToday = Object.values(todayJobs).reduce((n, jobs) => n + (Number(jobs) || 0), 0)
  return {
    day: today,
    freeJobsPerDay,
    freeEnqueuesToday,
    freeEnqueuesWindow: entries.reduce((n, e) => n + e.jobs, 0),
    freeUsersToday: Object.keys(todayJobs).length,
    freeUsersWindow: entries.length,
    freeUsersAtCap: entries.filter((e) => e.atCap).length,
    topFreeUsers: entries.slice(0, 12)
  }
}
