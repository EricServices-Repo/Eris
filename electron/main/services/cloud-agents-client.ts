import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import {
  CLOUD_AGENTS_BASE_URL,
  CLOUD_AGENTS_HEALTH_PATH,
  CLOUD_AGENTS_JOBS_PATH,
  type CloudHealth,
  type CloudJob,
  type EnqueueCloudJobRequest
} from '../../../src/shared/cloud-agents'
import type { BackgroundJob } from '../../../src/shared/background-agents'
import { deriveBlackboardStatus } from '../../../src/shared/agent-orchestration'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.eris',
  'coverage',
  '.next',
  'build',
  'vendor'
])

/** Always the public Eris Cloud Agents host — not user-configurable. */
export function cloudAgentsBaseUrl(): string {
  return CLOUD_AGENTS_BASE_URL
}

async function cloudFetch(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${cloudAgentsBaseUrl()}${path}`
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Eris-Client': 'eris-desktop',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined)
      }
    })
    const text = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      return {
        ok: false,
        status: res.status,
        data: {},
        error: `Unexpected response from Cloud Agents (${res.status})`
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
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {},
      error: err instanceof Error ? err.message : 'Network error reaching Cloud Agents'
    }
  }
}

export async function cloudAgentsHealth(): Promise<CloudHealth> {
  const r = await cloudFetch(CLOUD_AGENTS_HEALTH_PATH)
  if (!r.ok) {
    return {
      ok: false,
      service: 'eris-cloud-agent',
      version: '',
      llmConfigured: false,
      maxParallel: 0,
      running: 0,
      queued: 0,
      error: r.error || 'Unreachable'
    }
  }
  const localModel = r.data.localModel as CloudHealth['localModel'] | undefined
  return {
    ok: true,
    service: String(r.data.service || 'eris-cloud-agent'),
    version: String(r.data.version || ''),
    llmConfigured: r.data.llmConfigured !== false,
    localModel:
      localModel && typeof localModel === 'object'
        ? {
            status: localModel.status,
            modelId: String(localModel.modelId || ''),
            modelName: String(localModel.modelName || ''),
            error: localModel.error
          }
        : undefined,
    inference: r.data.inference === 'remote' ? 'remote' : 'local',
    maxParallel: Number(r.data.maxParallel || 0),
    running: Number(r.data.running || 0),
    queued: Number(r.data.queued || 0),
    publicBaseUrl:
      typeof r.data.publicBaseUrl === 'string' ? r.data.publicBaseUrl : CLOUD_AGENTS_BASE_URL
  }
}

export async function listCloudJobs(limit = 50): Promise<CloudJob[]> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}?limit=${limit}`)
  if (!r.ok) return []
  const jobs = r.data.jobs
  return Array.isArray(jobs) ? (jobs as CloudJob[]) : []
}

export async function getCloudJob(id: string): Promise<CloudJob | null> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(id)}`)
  if (!r.ok) return null
  return (r.data.job as CloudJob) || null
}

export async function enqueueCloudJob(req: EnqueueCloudJobRequest): Promise<CloudJob> {
  const r = await cloudFetch(CLOUD_AGENTS_JOBS_PATH, {
    method: 'POST',
    body: JSON.stringify({
      goal: req.goal,
      agentId: req.agentId,
      model: req.model,
      repoUrl: req.repoUrl,
      branch: req.branch,
      claim: req.claim,
      files: req.files,
      source: 'eris'
    })
  })
  if (!r.ok || !r.data.job) {
    throw new Error(r.error || 'Failed to enqueue cloud job')
  }
  return r.data.job as CloudJob
}

export async function stopCloudJob(id: string): Promise<boolean> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    body: '{}'
  })
  return r.ok
}

/** Collect a bounded set of text files for cloud workspace seeding. */
export function collectWorkspaceFilesForCloud(
  workspacePath: string,
  options: { maxFiles?: number; maxBytes?: number } = {}
): Array<{ path: string; content: string }> {
  const maxFiles = options.maxFiles ?? 80
  const maxBytes = options.maxBytes ?? 120_000
  const out: Array<{ path: string; content: string }> = []
  let total = 0

  const walk = (dir: string) => {
    if (out.length >= maxFiles || total >= maxBytes * maxFiles) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      if (out.length >= maxFiles) return
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      if (!st.isFile() || st.size > maxBytes) continue
      if (!/\.(ts|tsx|js|jsx|json|md|css|html|py|go|rs|toml|yml|yaml|swift|mjs|cjs)$/i.test(name)) {
        continue
      }
      try {
        const content = readFileSync(abs, 'utf8')
        if (content.includes('\0')) continue
        const path = relative(workspacePath, abs).replace(/\\/g, '/')
        out.push({ path, content })
        total += content.length
      } catch {
        // skip
      }
    }
  }

  if (workspacePath && existsSync(workspacePath)) walk(workspacePath)
  return out
}

export function cloudJobToBackgroundJob(job: CloudJob, workspacePath: string): BackgroundJob {
  const status =
    job.status === 'queued'
      ? 'queued'
      : job.status === 'running'
        ? 'running'
        : job.status === 'done'
          ? 'done'
          : job.status === 'stopped'
            ? 'stopped'
            : 'failed'
  const mapped: BackgroundJob = {
    id: `cloud:${job.id}`,
    workspacePath: workspacePath || '',
    worktreePath: '',
    branch: job.branch || '',
    goal: job.goal,
    model: job.model,
    agentId: job.agentId,
    agentName: job.agentName,
    source: 'panel',
    claim: job.claim || `cloud: ${job.goal.slice(0, 48)}`,
    status,
    step: job.recentTools.length,
    actionLog: [],
    filesTouched: job.filesTouched || [],
    answer: job.answer || '',
    liveStatus: job.liveStatus,
    recentTools: (job.recentTools || []).map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path,
      status: t.status,
      detail: t.detail,
      at: t.at
    })),
    thinkingTail: job.thinkingTail || '',
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    routeReason: `Cloud · ${CLOUD_AGENTS_BASE_URL.replace(/^https?:\/\//, '')}`
  }
  mapped.blackboard = deriveBlackboardStatus(mapped)
  return mapped
}
