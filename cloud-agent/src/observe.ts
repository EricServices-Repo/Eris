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

function auditPath(): string {
  return join(config.dataDir, 'audit.jsonl')
}

export function newRequestId(): string {
  return randomUUID().slice(0, 12)
}

export function bumpMetric(key: keyof Omit<Metrics, 'startedAt'>, n = 1): void {
  metrics[key] = (metrics[key] as number) + n
}

export function getMetrics(): Metrics & { uptimeSec: number } {
  const started = Date.parse(metrics.startedAt)
  return {
    ...metrics,
    uptimeSec: Number.isFinite(started) ? Math.round((Date.now() - started) / 1000) : 0
  }
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
