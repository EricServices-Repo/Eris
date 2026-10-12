import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import type { AuthContext } from './auth.js'
import type { JobStore } from './job-store.js'

type DayUsage = { day: string; jobs: Record<string, number> }

function usagePath(): string {
  return join(config.dataDir, 'usage-daily.json')
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function loadUsage(): DayUsage {
  try {
    if (!existsSync(usagePath())) return { day: todayKey(), jobs: {} }
    const raw = JSON.parse(readFileSync(usagePath(), 'utf8')) as DayUsage
    if (raw.day !== todayKey()) return { day: todayKey(), jobs: {} }
    return { day: raw.day, jobs: raw.jobs || {} }
  } catch {
    return { day: todayKey(), jobs: {} }
  }
}

function saveUsage(u: DayUsage): void {
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(usagePath(), JSON.stringify(u, null, 2), 'utf8')
}

export function assertCanEnqueue(
  auth: AuthContext,
  store: JobStore
): { ok: true } | { ok: false; error: string } {
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
    const used = usage.jobs[owner] || 0
    if (used >= config.freeJobsPerDay) {
      return {
        ok: false,
        error: `Free plan daily Cloud Agent limit reached (${config.freeJobsPerDay}). Upgrade to Pro.`
      }
    }
  }
  return { ok: true }
}

export function recordEnqueue(auth: AuthContext): void {
  if (auth.plan === 'pro') return
  const usage = loadUsage()
  usage.jobs[auth.owner] = (usage.jobs[auth.owner] || 0) + 1
  saveUsage(usage)
}

/** Mask owner for the public :80 status page (no full emails/usernames). */
export function maskOwner(owner: string): string {
  const s = String(owner || '').trim() || 'anonymous'
  if (s === 'anonymous') return 'anonymous'
  if (s.length <= 4) return s[0] + '…'
  return s.slice(0, 2) + '…' + s.slice(-2)
}

/**
 * Daily free-plan enqueue usage (UTC day). Safe for the public status page.
 */
export function getUsageOverview(): {
  day: string
  freeJobsPerDay: number
  freeEnqueuesToday: number
  freeUsersToday: number
  freeUsersAtCap: number
  topFreeUsers: Array<{ owner: string; jobs: number; atCap: boolean }>
} {
  const usage = loadUsage()
  const freeJobsPerDay = config.freeJobsPerDay
  const entries = Object.entries(usage.jobs || {})
    .map(([owner, jobs]) => {
      const n = Number(jobs) || 0
      return { owner: maskOwner(owner), jobs: n, atCap: n >= freeJobsPerDay }
    })
    .filter((e) => e.jobs > 0)
    .sort((a, b) => b.jobs - a.jobs)
  const freeEnqueuesToday = entries.reduce((n, e) => n + e.jobs, 0)
  return {
    day: usage.day,
    freeJobsPerDay,
    freeEnqueuesToday,
    freeUsersToday: entries.length,
    freeUsersAtCap: entries.filter((e) => e.atCap).length,
    topFreeUsers: entries.slice(0, 12)
  }
}
