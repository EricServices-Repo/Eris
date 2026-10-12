import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import {
  CLOUD_AGENTS_BASE_URL,
  CLOUD_AGENTS_HEALTH_PATH,
  CLOUD_AGENTS_JOBS_PATH,
  cloudAgentsFallbackReason,
  isCloudAgentsReady,
  shouldUseCloudAgents,
  type CloudHealth,
  type CloudJob,
  type CloudJobArtifacts,
  type EnqueueCloudJobRequest
} from '../../../src/shared/cloud-agents'
import {
  createCheckpoint,
  recordWriteOp,
  snapshotBeforeWrite
} from './checkpoints'
import { writeWorkspaceFile } from './workspace-fs'

export interface CloudAppliedDiff {
  id: string
  checkpointId: string
  opIndex: number
  path: string
  before: string | null
  after: string
  op: 'write'
  status: 'pending'
}
import type { BackgroundJob } from '../../../src/shared/background-agents'
import { deriveBlackboardStatus } from '../../../src/shared/agent-orchestration'
import { logError, logInfo, logWarn } from './logger'

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

let lastHealthLogKey = ''
let lastHealthLogAt = 0
const HEALTH_LOG_COOLDOWN_MS = 30_000

function shouldLogHealthFailure(error: string): boolean {
  const now = Date.now()
  if (error !== lastHealthLogKey || now - lastHealthLogAt >= HEALTH_LOG_COOLDOWN_MS) {
    lastHealthLogKey = error
    lastHealthLogAt = now
    return true
  }
  return false
}

const DEFAULT_TIMEOUT_MS = 8_000
/** Health probes must fail fast — cloud offline must never stall the client. */
const HEALTH_TIMEOUT_MS = 2_500
const ENQUEUE_TIMEOUT_MS = 30_000

/** Bearer token from EricServic.es — set by IPC before authenticated calls. */
let cloudAuthToken: string | null = null

export function setCloudAgentsAuthToken(token: string | null | undefined): void {
  cloudAuthToken = token?.trim() || null
}

export function getCloudAgentsAuthToken(): string | null {
  return cloudAuthToken
}

async function cloudFetch(
  path: string,
  init?: RequestInit & { logLabel?: string; timeoutMs?: number; auth?: boolean }
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const { logLabel, timeoutMs = DEFAULT_TIMEOUT_MS, auth = true, ...fetchInit } = init || {}
  const method = (fetchInit.method || 'GET').toUpperCase()
  const url = `${cloudAgentsBaseUrl()}${path}`
  const label = logLabel || `${method} ${path}`
  const signal =
    fetchInit.signal ||
    (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined)

  const authHeaders: Record<string, string> = {}
  if (auth && cloudAuthToken) {
    authHeaders.Authorization = `Bearer ${cloudAuthToken}`
  }

  try {
    const res = await fetch(url, {
      ...fetchInit,
      signal,
      headers: {
        Accept: 'application/json',
        'X-Eris-Client': 'eris-desktop',
        ...authHeaders,
        ...(fetchInit.body ? { 'Content-Type': 'application/json' } : {}),
        ...(fetchInit.headers as Record<string, string> | undefined)
      }
    })
    const text = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      const error = `Unexpected response from Cloud Agents (${res.status})`
      logWarn('Cloud Agents response not JSON', {
        label,
        url,
        status: res.status,
        bodyPreview: text.slice(0, 240)
      })
      return { ok: false, status: res.status, data: {}, error }
    }
    if (!res.ok || data.ok === false) {
      const error =
        typeof data.error === 'string' ? data.error : `Request failed (${res.status})`
      logWarn('Cloud Agents request failed', {
        label,
        url,
        status: res.status,
        error,
        okFlag: data.ok
      })
      return { ok: false, status: res.status, data, error }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Network error reaching Cloud Agents'
    const cause =
      err instanceof Error && 'cause' in err
        ? String((err as Error & { cause?: unknown }).cause ?? '')
        : ''
    logWarn('Cloud Agents network error', {
      label,
      url,
      baseUrl: cloudAgentsBaseUrl(),
      error,
      cause: cause || undefined,
      name: err instanceof Error ? err.name : undefined
    })
    return { ok: false, status: 0, data: {}, error }
  }
}

export async function cloudAgentsHealth(authenticated = false): Promise<CloudHealth> {
  const r = await cloudFetch(CLOUD_AGENTS_HEALTH_PATH, {
    logLabel: 'health',
    timeoutMs: HEALTH_TIMEOUT_MS,
    auth: false
  })
  if (!r.ok) {
    const error = r.error || 'Unreachable'
    if (shouldLogHealthFailure(error)) {
      logWarn('Cloud Agents health check failed — using local agents', {
        baseUrl: cloudAgentsBaseUrl(),
        status: r.status,
        error,
        authenticated
      })
    }
    return {
      ok: false,
      service: 'eris-cloud-agent',
      version: '',
      llmConfigured: false,
      maxParallel: 0,
      running: 0,
      queued: 0,
      error,
      authenticated
    }
  }
  const localModel = r.data.localModel as CloudHealth['localModel'] | undefined
  const health: CloudHealth = {
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
            error: localModel.error,
            gpu:
              localModel.gpu === false
                ? false
                : typeof localModel.gpu === 'string'
                  ? localModel.gpu
                  : null
          }
        : undefined,
    gpuMode:
      r.data.gpuMode === 'cuda' ||
      r.data.gpuMode === 'vulkan' ||
      r.data.gpuMode === 'false' ||
      r.data.gpuMode === 'auto'
        ? r.data.gpuMode
        : undefined,
    inference: r.data.inference === 'remote' ? 'remote' : 'local',
    maxParallel: Number(r.data.maxParallel || 0),
    running: Number(r.data.running || 0),
    queued: Number(r.data.queued || 0),
    publicBaseUrl:
      typeof r.data.publicBaseUrl === 'string' ? r.data.publicBaseUrl : CLOUD_AGENTS_BASE_URL,
    authRequired: r.data.authRequired !== false,
    authenticated
  }

  if (lastHealthLogKey) {
    logInfo('Cloud Agents health recovered', {
      baseUrl: cloudAgentsBaseUrl(),
      version: health.version,
      inference: health.inference,
      localModel: health.localModel?.status,
      ready: isCloudAgentsReady(health),
      preferCloud: shouldUseCloudAgents(health)
    })
    lastHealthLogKey = ''
  } else {
    const fallback = cloudAgentsFallbackReason(health)
    if (fallback && shouldLogHealthFailure(fallback)) {
      logWarn('Cloud Agents unavailable — using local agents', {
        baseUrl: cloudAgentsBaseUrl(),
        reason: fallback,
        localModel: health.localModel,
        inference: health.inference,
        error: health.error
      })
    } else if (!isCloudAgentsReady(health) && shouldLogHealthFailure(health.localModel?.status || 'warming')) {
      logInfo('Cloud Agents reachable — warming model (still prefer cloud)', {
        baseUrl: cloudAgentsBaseUrl(),
        localModel: health.localModel?.status,
        inference: health.inference
      })
    }
  }

  return health
}

export async function listCloudJobs(limit = 50): Promise<CloudJob[]> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}?limit=${limit}`, {
    logLabel: 'list jobs'
  })
  if (!r.ok) {
    logWarn('Cloud Agents list jobs failed', {
      baseUrl: cloudAgentsBaseUrl(),
      error: r.error,
      status: r.status
    })
    return []
  }
  const jobs = r.data.jobs
  return Array.isArray(jobs) ? (jobs as CloudJob[]) : []
}

export async function getCloudJob(id: string): Promise<CloudJob | null> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(id)}`, {
    logLabel: `get job ${id.slice(0, 8)}`
  })
  if (!r.ok) {
    logWarn('Cloud Agents get job failed', { id, error: r.error, status: r.status })
    return null
  }
  return (r.data.job as CloudJob) || null
}

export async function enqueueCloudJob(req: EnqueueCloudJobRequest): Promise<CloudJob> {
  logInfo('Cloud Agents enqueue start', {
    baseUrl: cloudAgentsBaseUrl(),
    goal: req.goal.slice(0, 120),
    agentId: req.agentId,
    files: req.files?.length || 0,
    repoUrl: req.repoUrl || null,
    openPr: Boolean(req.openPr),
    hasGithubToken: Boolean(req.githubToken),
    resumeFromJobId: req.resumeFromJobId || null
  })
  const r = await cloudFetch(CLOUD_AGENTS_JOBS_PATH, {
    method: 'POST',
    logLabel: 'enqueue job',
    timeoutMs: ENQUEUE_TIMEOUT_MS,
    body: JSON.stringify({
      goal: req.goal,
      agentId: req.agentId,
      model: req.model,
      repoUrl: req.repoUrl,
      branch: req.branch,
      openPr: Boolean(req.openPr),
      githubToken: req.githubToken || undefined,
      resumeFromJobId: req.resumeFromJobId || undefined,
      claim: req.claim,
      files: req.files,
      source: 'eris'
    })
  })
  if (!r.ok || !r.data.job) {
    const error = r.error || 'Failed to enqueue cloud job'
    logError('Cloud Agents enqueue failed', {
      baseUrl: cloudAgentsBaseUrl(),
      status: r.status,
      error
    })
    throw new Error(error)
  }
  const job = r.data.job as CloudJob
  logInfo('Cloud Agents enqueue ok', { id: job.id, status: job.status, agentId: job.agentId })
  return job
}

/** Resume a finished/stopped/failed job from its server checkpoint. */
export async function continueCloudJob(
  id: string,
  extra: Partial<EnqueueCloudJobRequest> = {}
): Promise<CloudJob> {
  const rawId = id.replace(/^cloud:/, '')
  const r = await cloudFetch(
    `${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(rawId)}/continue`,
    {
      method: 'POST',
      logLabel: `continue job ${rawId.slice(0, 8)}`,
      timeoutMs: ENQUEUE_TIMEOUT_MS,
      body: JSON.stringify({
        goal: extra.goal,
        agentId: extra.agentId,
        model: extra.model,
        githubToken: extra.githubToken || undefined,
        openPr: extra.openPr,
        files: extra.files,
        claim: extra.claim
      })
    }
  )
  if (!r.ok || !r.data.job) {
    throw new Error(r.error || 'Failed to continue cloud job')
  }
  return r.data.job as CloudJob
}

export async function stopCloudJob(id: string): Promise<boolean> {
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    logLabel: `stop job ${id.slice(0, 8)}`,
    body: '{}'
  })
  if (!r.ok) {
    logWarn('Cloud Agents stop failed', { id, error: r.error, status: r.status })
  }
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
    hasArtifacts: Boolean(job.hasArtifacts),
    artifactCount: job.artifactCount || 0,
    artifactsTruncated: Boolean(job.artifactsTruncated),
    resumable: Boolean(job.resumable),
    prUrl: job.prUrl || undefined,
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

export async function fetchCloudJobArtifacts(id: string): Promise<CloudJobArtifacts> {
  const rawId = id.replace(/^cloud:/, '')
  const r = await cloudFetch(`${CLOUD_AGENTS_JOBS_PATH}/${encodeURIComponent(rawId)}/artifacts`, {
    logLabel: `artifacts ${rawId.slice(0, 8)}`,
    timeoutMs: ENQUEUE_TIMEOUT_MS
  })
  if (!r.ok || !Array.isArray(r.data.files)) {
    throw new Error(r.error || 'No artifacts available for this cloud job')
  }
  return {
    jobId: String(r.data.jobId || rawId),
    createdAt: String(r.data.createdAt || ''),
    files: (r.data.files as CloudJobArtifacts['files']).map((f) => ({
      path: String(f.path || ''),
      content: String(f.content ?? ''),
      before: f.before == null ? null : String(f.before)
    })),
    truncated: Boolean(r.data.truncated),
    totalBytes: Number(r.data.totalBytes || 0)
  }
}

/**
 * Pull the cloud patch bundle and write it into the local workspace under a checkpoint
 * so Diff Review can Keep / Undo each file.
 */
export async function applyCloudJobArtifacts(
  workspacePath: string,
  jobId: string
): Promise<{
  ok: boolean
  checkpointId: string
  diffs: CloudAppliedDiff[]
  truncated: boolean
  error?: string
}> {
  if (!workspacePath) {
    return { ok: false, checkpointId: '', diffs: [], truncated: false, error: 'Open a workspace first' }
  }
  try {
    const pack = await fetchCloudJobArtifacts(jobId)
    if (pack.files.length === 0) {
      return {
        ok: false,
        checkpointId: '',
        diffs: [],
        truncated: pack.truncated,
        error: 'Artifact bundle is empty'
      }
    }
    const checkpoint = createCheckpoint(workspacePath)
    const diffs: CloudAppliedDiff[] = []
    for (let i = 0; i < pack.files.length; i++) {
      const file = pack.files[i]!
      const path = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!path || path.includes('..')) continue
      const before = snapshotBeforeWrite(workspacePath, checkpoint.id, path)
      writeWorkspaceFile(workspacePath, path, file.content)
      recordWriteOp(workspacePath, checkpoint.id, path, before, file.content)
      diffs.push({
        id: `${checkpoint.id}:${i}`,
        checkpointId: checkpoint.id,
        opIndex: i,
        path,
        before,
        after: file.content,
        op: 'write',
        status: 'pending'
      })
    }
    logInfo('Cloud artifacts applied', {
      jobId,
      files: diffs.length,
      truncated: pack.truncated,
      checkpointId: checkpoint.id
    })
    return {
      ok: true,
      checkpointId: checkpoint.id,
      diffs,
      truncated: pack.truncated
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logError('Cloud artifacts apply failed', { jobId, error })
    return { ok: false, checkpointId: '', diffs: [], truncated: false, error }
  }
}
