import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import type { CloudJob, CloudJobCreateRequest, CloudJobStatus } from './types.js'

const AGENT_NAMES: Record<string, string> = {
  composer: 'Composer',
  coder: 'Coder',
  explainer: 'Explainer',
  reviewer: 'Reviewer',
  fast: 'Fast'
}

function storeFile(): string {
  return join(config.dataDir, 'jobs.json')
}

export class JobStore {
  private jobs = new Map<string, CloudJob>()

  constructor() {
    mkdirSync(config.dataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(storeFile())) return
      const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as { jobs?: CloudJob[] }
      for (const job of raw.jobs ?? []) {
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'stopped'
          job.error = job.error || 'Interrupted when worker restarted'
          job.liveStatus = 'Stopped'
          job.updatedAt = new Date().toISOString()
        }
        this.jobs.set(job.id, job)
      }
    } catch {
      // ignore
    }
  }

  private persist(): void {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(
      storeFile(),
      JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2),
      'utf8'
    )
  }

  list(limit = 50): CloudJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
  }

  get(id: string): CloudJob | null {
    return this.jobs.get(id) ?? null
  }

  counts(): { running: number; queued: number } {
    let running = 0
    let queued = 0
    for (const j of this.jobs.values()) {
      if (j.status === 'running') running++
      if (j.status === 'queued') queued++
    }
    return { running, queued }
  }

  create(req: CloudJobCreateRequest): CloudJob {
    const goal = String(req.goal || '').trim()
    if (!goal) throw new Error('goal is required')
    const agentId = (req.agentId || 'composer').trim() || 'composer'
    const now = new Date().toISOString()
    const job: CloudJob = {
      id: randomUUID(),
      goal,
      agentId,
      agentName: AGENT_NAMES[agentId] || agentId,
      model: (req.model || config.llmModel).trim() || config.llmModel,
      status: 'queued',
      claim: (req.claim || goal).slice(0, 80),
      repoUrl: req.repoUrl || null,
      branch: req.branch || null,
      liveStatus: 'Queued',
      answer: '',
      filesTouched: [],
      recentTools: [],
      thinkingTail: '',
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(job.id, job)
    this.persist()
    return job
  }

  patch(id: string, fn: (job: CloudJob) => CloudJob): CloudJob | null {
    const cur = this.jobs.get(id)
    if (!cur) return null
    const next = { ...fn({ ...cur }), updatedAt: new Date().toISOString() }
    this.jobs.set(id, next)
    this.persist()
    return next
  }

  setStatus(id: string, status: CloudJobStatus, extra: Partial<CloudJob> = {}): CloudJob | null {
    return this.patch(id, (j) => ({
      ...j,
      ...extra,
      status,
      finishedAt:
        status === 'done' || status === 'failed' || status === 'stopped'
          ? new Date().toISOString()
          : j.finishedAt
    }))
  }
}
