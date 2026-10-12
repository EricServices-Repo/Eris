import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'
import { jobEvents } from './events.js'
import { loadCheckpoint } from './job-secrets.js'
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
        if (job.status === 'running') {
          const cp = loadCheckpoint(job.id)
          // CPU-only: do not auto re-queue on boot — that pegs all cores and can lock out SSH.
          // Jobs stay resumable via continue / Force kill is a no-op for stopped.
          if (config.gpu === 'false') {
            job.status = 'stopped'
            job.resumable = true
            if (cp?.step != null) job.step = cp.step
            job.liveStatus = 'Stopped (safe boot — resume manually)'
            job.error = 'Interrupted by restart (CPU safe-boot)'
          } else if (cp && cp.messages?.length) {
            job.status = 'queued'
            job.resumable = true
            job.step = cp.step
            job.liveStatus = 'Queued (resume after restart)'
            job.error = undefined
          } else {
            job.status = 'queued'
            job.resumable = true
            job.liveStatus = 'Queued (restart recovery)'
            job.error = undefined
          }
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

  list(limit = 50, ownerId?: string | null): CloudJob[] {
    let list = [...this.jobs.values()]
    if (ownerId) list = list.filter((j) => j.ownerId === ownerId)
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
  }

  get(id: string): CloudJob | null {
    return this.jobs.get(id) ?? null
  }

  counts(ownerId?: string | null): { running: number; queued: number } {
    let running = 0
    let queued = 0
    for (const j of this.jobs.values()) {
      if (ownerId && j.ownerId !== ownerId) continue
      if (j.status === 'running') running++
      if (j.status === 'queued') queued++
    }
    return { running, queued }
  }

  create(
    req: CloudJobCreateRequest,
    meta?: { ownerId?: string; plan?: 'free' | 'pro' }
  ): CloudJob {
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
      ownerId: meta?.ownerId,
      plan: meta?.plan,
      repoUrl: req.repoUrl || null,
      branch: req.branch || null,
      openPr: Boolean(req.openPr),
      liveStatus: 'Queued',
      answer: '',
      filesTouched: [],
      recentTools: [],
      thinkingTail: '',
      step: 0,
      resumable: true,
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(job.id, job)
    this.persist()
    jobEvents.emitJob(job)
    return job
  }

  patch(id: string, fn: (job: CloudJob) => CloudJob): CloudJob | null {
    const cur = this.jobs.get(id)
    if (!cur) return null
    const next = { ...fn({ ...cur }), updatedAt: new Date().toISOString() }
    this.jobs.set(id, next)
    this.persist()
    jobEvents.emitJob(next)
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
