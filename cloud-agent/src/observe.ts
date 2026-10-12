import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

export type Metrics = {
  requests: number
  enqueues: number
  authFailures: number
  jobsDone: number
  jobsFailed: number
  jobsStopped: number
  toolDenied: number
  startedAt: string
}

const metrics: Metrics = {
  requests: 0,
  enqueues: 0,
  authFailures: 0,
  jobsDone: 0,
  jobsFailed: 0,
  jobsStopped: 0,
  toolDenied: 0,
  startedAt: new Date().toISOString()
}

/** Restore counters from disk after restart (best-effort). */
export function loadMetricsSnapshot(): void {
  try {
    const path = join(config.dataDir, 'metrics.json')
    if (!existsSync(path)) return
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Metrics>
    for (const key of [
      'requests',
      'enqueues',
      'authFailures',
      'jobsDone',
      'jobsFailed',
      'jobsStopped',
      'toolDenied'
    ] as const) {
      const n = Number(raw[key])
      if (Number.isFinite(n) && n >= 0) metrics[key] = Math.floor(n)
    }
    if (typeof raw.startedAt === 'string' && raw.startedAt) {
      metrics.startedAt = raw.startedAt
    }
  } catch {
    // ignore
  }
}

function auditPath(): string {
  return join(config.dataDir, 'audit.jsonl')
}

export function newRequestId(): string {
  return randomUUID().slice(0, 12)
}

export function bumpMetric(key: keyof Omit<Metrics, 'startedAt'>, n = 1): void {
  metrics[key] = (metrics[key] as number) + n
}

export function getMetrics(): Metrics & {
  uptimeSec: number
  successRate: number | null
  terminalJobs: number
} {
  const started = Date.parse(metrics.startedAt)
  const terminal = metrics.jobsDone + metrics.jobsFailed + metrics.jobsStopped
  return {
    ...metrics,
    uptimeSec: Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : 0,
    terminalJobs: terminal,
    successRate: terminal > 0 ? Math.round((metrics.jobsDone / terminal) * 1000) / 10 : null
  }
}

/** Recent audit lines stripped for the public status page. */
export function readPublicAudit(limit = 30): Array<Record<string, unknown>> {
  return readRecentAudit(limit).map((row) => {
    if (!row || typeof row !== 'object') return { raw: String(row) }
    const o = { ...(row as Record<string, unknown>) }
    delete o.token
    delete o.authorization
    delete o.githubToken
    if (typeof o.owner === 'string') {
      const s = o.owner
      o.owner =
        s === 'anonymous' ? s : s.length <= 4 ? s[0] + '…' : s.slice(0, 2) + '…' + s.slice(-2)
    }
    if (typeof o.error === 'string') o.error = o.error.slice(0, 160)
    if (typeof o.goal === 'string') delete o.goal
    return o
  })
}

export function audit(event: string, fields: Record<string, unknown> = {}): void {
  try {
    mkdirSync(config.dataDir, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...fields
    })
    appendFileSync(auditPath(), line + '\n', 'utf8')
  } catch {
    // ignore disk errors
  }
  process.stdout.write(`${JSON.stringify({ msg: 'audit', event, ...fields })}\n`)
}

export function readRecentAudit(limit = 50): unknown[] {
  try {
    if (!existsSync(auditPath())) return []
    const lines = readFileSync(auditPath(), 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { raw: l }
        }
      })
  } catch {
    return []
  }
}

export function persistMetricsSnapshot(): void {
  try {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(join(config.dataDir, 'metrics.json'), JSON.stringify(getMetrics(), null, 2))
  } catch {
    // ignore
  }
}
