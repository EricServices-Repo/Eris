import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type { BackgroundJob, BackgroundJobEvent } from '../../../src/shared/background-agents'
import { runAgentWithWorkspaceTools } from './agent-runner'
import { userDataRoot } from './paths'
import { workspaceKey } from './workspace-trust'
import {
  addAgentWorktree,
  diffWorktree,
  mergeAgentBranch,
  removeAgentWorktree
} from './worktrees'
import { logError, logInfo } from './logger'
import { requestCommandApproval } from './command-approval'
import { workspaceAllowedCommands, addWorkspaceAllowedCommand } from './workspace-trust'
import { commandNeedsApproval, normalizeCommand } from './command-approval'
import { getResolvedSettings } from './settings'
import type { WebContents } from 'electron'

const jobs = new Map<string, BackgroundJob>()
const aborts = new Map<string, AbortController>()
const listeners = new Set<(event: BackgroundJobEvent) => void>()
let pumping = false

function storePath(): string {
  return join(userDataRoot(), 'background-jobs.json')
}

function persist(): void {
  mkdirSync(userDataRoot(), { recursive: true })
  writeFileSync(storePath(), JSON.stringify({ jobs: [...jobs.values()] }, null, 2), 'utf8')
}

function loadPersisted(): void {
  if (jobs.size > 0) return
  try {
    if (!existsSync(storePath())) return
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as { jobs?: BackgroundJob[] }
    for (const job of raw.jobs ?? []) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'stopped'
        job.error = job.error || 'Interrupted when Eris quit'
        job.updatedAt = new Date().toISOString()
      }
      jobs.set(job.id, job)
    }
  } catch {
    // ignore
  }
}

function emit(event: BackgroundJobEvent): void {
  persist()
  for (const l of listeners) {
    try {
      l(event)
    } catch {
      // ignore
    }
  }
}

function upsert(job: BackgroundJob): BackgroundJob {
  job.updatedAt = new Date().toISOString()
  jobs.set(job.id, job)
  emit({ type: 'upsert', job })
  return job
}

export function onBackgroundJobEvent(cb: (event: BackgroundJobEvent) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function listBackgroundJobs(workspacePath: string | null): BackgroundJob[] {
  loadPersisted()
  if (!workspacePath) return [...jobs.values()]
  const key = workspaceKey(workspacePath)
  return [...jobs.values()].filter((j) => {
    try {
      return workspaceKey(j.workspacePath) === key
    } catch {
      return j.workspacePath === workspacePath
    }
  })
}

export function getBackgroundJob(id: string): BackgroundJob | null {
  loadPersisted()
  return jobs.get(id) ?? null
}

export function enqueueBackgroundJob(options: {
  workspacePath: string
  goal: string
  model: string
  agentId?: string
}): BackgroundJob {
  loadPersisted()
  const now = new Date().toISOString()
  const job: BackgroundJob = {
    id: randomUUID(),
    workspacePath: options.workspacePath,
    worktreePath: '',
    branch: '',
    goal: options.goal.trim(),
    model: options.model,
    agentId: options.agentId || 'composer',
    status: 'queued',
    step: 0,
    actionLog: [],
    filesTouched: [],
    answer: '',
    createdAt: now,
    updatedAt: now
  }
  upsert(job)
  void pumpQueue()
  return job
}

export function stopBackgroundJob(id: string): boolean {
  const ac = aborts.get(id)
  if (ac) {
    ac.abort()
    return true
  }
  const job = jobs.get(id)
  if (job && job.status === 'queued') {
    upsert({ ...job, status: 'stopped', error: 'Cancelled before start' })
    return true
  }
  return false
}

export async function discardBackgroundJob(id: string): Promise<BackgroundJob> {
  const job = jobs.get(id)
  if (!job) throw new Error('Job not found')
  stopBackgroundJob(id)
  if (job.worktreePath && job.branch) {
    try {
      await removeAgentWorktree(job.workspacePath, { path: job.worktreePath, branch: job.branch })
    } catch {
      // still mark discarded
    }
  }
  const next = upsert({ ...job, status: 'discarded' })
  return next
}

export async function mergeBackgroundJob(id: string): Promise<BackgroundJob> {
  const job = jobs.get(id)
  if (!job) throw new Error('Job not found')
  if (job.status !== 'done') throw new Error('Only finished jobs can be merged')
  const merged = await mergeAgentBranch(job.workspacePath, job.branch)
  if (!merged.ok) throw new Error(merged.error || 'Merge failed')
  try {
    await removeAgentWorktree(job.workspacePath, { path: job.worktreePath, branch: job.branch })
  } catch {
    // branch is already merged
  }
  return upsert({ ...job, status: 'merged', actionLog: [...job.actionLog, 'Merged into current branch'] })
}

export async function backgroundJobDiff(id: string): Promise<{ ok: boolean; diff: string; error?: string }> {
  const job = jobs.get(id)
  if (!job?.branch) return { ok: false, diff: '', error: 'Job has no branch' }
  return diffWorktree(job.workspacePath, job.branch)
}

export async function stopAllBackgroundJobs(): Promise<void> {
  for (const id of aborts.keys()) stopBackgroundJob(id)
}

async function pumpQueue(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    loadPersisted()
    while (true) {
      const queued = [...jobs.values()].filter((j) => j.status === 'queued')
      if (queued.length === 0) break
      const byWorkspace = new Map<string, BackgroundJob[]>()
      for (const job of queued) {
        const key = workspaceKey(job.workspacePath)
        const list = byWorkspace.get(key) ?? []
        list.push(job)
        byWorkspace.set(key, list)
      }
      let started = false
      for (const group of byWorkspace.values()) {
        const first = group[0]
        if (!first) continue
        const settings = getResolvedSettings(first.workspacePath)
        const running = [...jobs.values()].filter(
          (j) =>
            j.status === 'running' && workspaceKey(j.workspacePath) === workspaceKey(first.workspacePath)
        ).length
        if (running >= settings.backgroundAgents.maxParallel) continue
        started = true
        await runOne(first, settings)
      }
      if (!started) break
    }
  } finally {
    pumping = false
  }
}

async function runOne(job: BackgroundJob, settings: AppSettings): Promise<void> {
  const ac = new AbortController()
  aborts.set(job.id, ac)
  try {
    const tree = await addAgentWorktree(
      job.workspacePath,
      job.id,
      settings.backgroundAgents.linkNodeModules
    )
    upsert({ ...job, worktreePath: tree.path, branch: tree.branch, status: 'running' })
    const live = getBackgroundJob(job.id)!
    const sender = currentSender
    for await (const evt of runAgentWithWorkspaceTools({
      workspacePath: tree.path,
      settings,
      model: live.model,
      messages: [{ role: 'user', content: live.goal }],
      temperature: settings.models.temperature,
      signal: ac.signal,
      getSecret: currentGetSecret,
      mode: 'agent',
      mcp: 'reuse',
      approveCommand: async (kind, command) => {
        const resolved = getResolvedSettings(job.workspacePath)
        const allowed = workspaceAllowedCommands(job.workspacePath)
        if (!commandNeedsApproval(resolved, kind, command, allowed)) return true
        if (!sender || sender.isDestroyed()) return false
        const decision = await requestCommandApproval(sender, job.id, kind, command, ac.signal)
        if (decision === 'always') {
          addWorkspaceAllowedCommand(job.workspacePath, normalizeCommand(command))
        }
        return decision !== 'deny'
      }
    })) {
      const cur = getBackgroundJob(job.id)
      if (!cur) break
      if (evt.type === 'answer') upsert({ ...cur, answer: cur.answer + evt.text })
      else if (evt.type === 'progress') {
        upsert({
          ...cur,
          step: evt.step,
          actionLog: evt.actionLog,
          filesTouched: evt.filesTouched
        })
      } else if (evt.type === 'status') {
        upsert({ ...cur, actionLog: [...cur.actionLog, evt.text].slice(-80) })
      }
    }
    const done = getBackgroundJob(job.id)
    if (done && done.status === 'running') {
      upsert({ ...done, status: ac.signal.aborted ? 'stopped' : 'done' })
    }
    logInfo('Background agent finished', { id: job.id, status: getBackgroundJob(job.id)?.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const aborted = err instanceof Error && err.name === 'AbortError'
    const cur = getBackgroundJob(job.id)
    if (cur) {
      upsert({
        ...cur,
        status: aborted ? 'stopped' : 'failed',
        error: aborted ? 'Stopped' : message
      })
    }
    logError('Background agent failed', { id: job.id, error: message })
  } finally {
    aborts.delete(job.id)
    void pumpQueue()
  }
}

let currentSender: WebContents | null = null
let currentGetSecret: (key: string) => string | null = () => null

export function configureBackgroundAgents(options: {
  sender: WebContents | null
  getSecret: (key: string) => string | null
}): void {
  currentSender = options.sender
  currentGetSecret = options.getSecret
}
