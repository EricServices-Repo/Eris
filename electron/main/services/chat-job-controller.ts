import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, open, readdir, rename, unlink } from 'fs/promises'
import { join } from 'path'
import type { ChatJobSnapshot, ChatJobStatus } from '../../../src/shared/chat-jobs'
import { userDataRoot } from './paths'
import { logWarn } from './logger'

const jobs = new Map<string, ChatJobSnapshot>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const admissions = new Map<string, Promise<void>>()
const MAX_EVENTS = 240
const MAX_MEMORY = 200
const MAX_DISK = 500
const MAX_AGE_MS = 30 * 86400000
let persistGate: Promise<void> = Promise.resolve()
const root = () => join(userDataRoot(), 'chat-jobs')
const jobPath = (id: string) =>
  join(root(), createHash('sha256').update(id).digest('hex') + '.json')
const latestPath = () => join(root(), 'latest.json')
const threadPath = (workspace: string | null, thread: string | null) =>
  join(
    root(),
    'thread-' +
      createHash('sha256')
        .update(JSON.stringify([workspace, thread]))
        .digest('hex') +
      '.json'
  )
const active = (job: ChatJobSnapshot) => job.status === 'running' || job.status === 'queued'

function persistNow(job: ChatJobSnapshot, updateIndexes = true): Promise<void> {
  const snapshot = structuredClone(job)
  const write = persistGate
    .then(async () => {
      await mkdir(root(), { recursive: true })
      const body = JSON.stringify(snapshot)
      for (const path of updateIndexes
        ? [
            jobPath(snapshot.id),
            latestPath(),
            threadPath(snapshot.workspacePath, snapshot.threadId)
          ]
        : [jobPath(snapshot.id)]) {
        const file = await open(`${path}.tmp`, 'w', 0o600)
        try {
          await file.writeFile(
            path === threadPath(snapshot.workspacePath, snapshot.threadId)
              ? JSON.stringify({ id: snapshot.id })
              : body,
            'utf8'
          )
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(`${path}.tmp`, path)
      }
      delete job.persistenceError
    })
    .catch(() => {
      job.persistenceError = 'Task storage is unavailable. Reconnection may not recover this task.'
      logWarn('Chat task persistence failed', { taskId: job.id })
      throw new Error(job.persistenceError)
    })
  persistGate = write.catch(() => undefined)
  return write
}
function persistLater(job: ChatJobSnapshot): void {
  void persistNow(job).catch(() => undefined)
}
function schedulePersist(job: ChatJobSnapshot): void {
  if (persistTimers.has(job.id)) return
  persistTimers.set(
    job.id,
    setTimeout(() => {
      persistTimers.delete(job.id)
      persistLater(job)
    }, 100)
  )
}
function pruneMemory(): void {
  const terminal = [...jobs.values()]
    .filter((job) => !active(job))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const job of terminal.slice(MAX_MEMORY)) jobs.delete(job.id)
}
async function pruneDisk(): Promise<void> {
  const terminal: Array<{ path: string; at: string; id: string; thread: string }> = []
  for (const file of await readdir(root())) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const path = join(root(), file)
    try {
      const job = JSON.parse(readFileSync(path, 'utf8')) as ChatJobSnapshot
      if (active(job) && !jobs.has(job.id)) {
        job.status = 'stopped'
        job.statusText = 'Stopped when Eris closed'
        await persistNow(job, false)
      }
      if (!active(job))
        terminal.push({
          path,
          at: job.updatedAt,
          id: job.id,
          thread: threadPath(job.workspacePath, job.threadId)
        })
    } catch {
      /* malformed records do not authorize deletion */
    }
  }
  terminal.sort((a, b) => b.at.localeCompare(a.at))
  for (const [index, record] of terminal.entries()) {
    if (index >= MAX_DISK || Date.parse(record.at) < Date.now() - MAX_AGE_MS) {
      await unlink(record.path)
      try {
        if (JSON.parse(readFileSync(record.thread, 'utf8')).id === record.id)
          await unlink(record.thread)
      } catch {
        /* already pruned or a newer task owns this thread */
      }
    }
  }
}
export function startChatJob(
  input: {
    id: string
    workspacePath: string | null
    threadId: string | null
    goal: string
    submissionDigest?: string
  },
  persist = true
): ChatJobSnapshot {
  const now = new Date().toISOString()
  const job: ChatJobSnapshot = {
    ...input,
    status: 'running',
    statusText: 'Planning…',
    answer: '',
    model: null,
    startedAt: now,
    updatedAt: now,
    events: []
  }
  jobs.set(job.id, job)
  pruneMemory()
  if (persist) persistLater(job)
  return job
}
/** Admission is durable before the caller may start inference or execute effects. */
export async function admitChatJob(input: {
  id: string
  workspacePath: string | null
  threadId: string | null
  goal: string
  submissionDigest: string
}): Promise<{ duplicate: boolean; job: ChatJobSnapshot }> {
  const existing = getChatJob(input.id)
  if (existing) {
    if (existing.submissionDigest !== input.submissionDigest)
      throw new Error('Request ID conflict: use a new ID for different content.')
    await admissions.get(input.id)
    return { duplicate: true, job: getChatJob(input.id)! }
  }
  const job = startChatJob(input, false)
  job.status = 'queued'
  job.statusText = 'Queued'
  const write = persistNow(job)
  admissions.set(job.id, write)
  try {
    await write
  } catch (error) {
    jobs.delete(job.id)
    throw error
  } finally {
    admissions.delete(job.id)
  }
  void pruneDisk().catch(() => logWarn('Chat task retention cleanup failed'))
  return { duplicate: false, job: structuredClone(job) }
}
export function markChatJobRunning(id: string): void {
  const job = jobs.get(id)
  if (job) {
    job.status = 'running'
    job.statusText = 'Planning…'
    job.updatedAt = new Date().toISOString()
    persistLater(job)
  }
}
export function recordChatJobEvent(
  id: string,
  channel: string,
  payload: Record<string, unknown>
): void {
  const job = jobs.get(id)
  if (!job) return
  job.updatedAt = new Date().toISOString()
  if (channel === 'chat:answer') {
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : ''
    job.answer = payload.replace ? chunk : job.answer + chunk
  } else if (channel === 'chat:status')
    job.statusText = typeof payload.text === 'string' ? payload.text : job.statusText
  else if (channel === 'chat:model')
    job.model = typeof payload.model === 'string' ? payload.model : job.model
  if (channel !== 'chat:thinking' && channel !== 'chat:answer') {
    job.cursor = (job.cursor ?? job.events.at(-1)?.sequence ?? 0) + 1
    job.events.push({ sequence: job.cursor, at: job.updatedAt, channel, payload })
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS)
  }
  schedulePersist(job)
}
export function finishChatJob(id: string, status: ChatJobStatus): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = status
  job.statusText =
    status === 'done'
      ? 'Done'
      : status === 'stopped'
        ? 'Stopped'
        : status === 'incomplete'
          ? 'Incomplete'
          : 'Failed'
  job.updatedAt = new Date().toISOString()
  const timer = persistTimers.get(id)
  if (timer) clearTimeout(timer)
  persistTimers.delete(id)
  persistLater(job)
  pruneMemory()
}
function recovered(job: ChatJobSnapshot): ChatJobSnapshot {
  if (active(job)) {
    job.status = 'stopped'
    job.statusText = 'Stopped when Eris closed'
    job.updatedAt = new Date().toISOString()
    persistLater(job)
  }
  jobs.set(job.id, job)
  return structuredClone(job)
}
export function getLatestChatJob(
  workspacePath?: string | null,
  threadId?: string | null
): ChatJobSnapshot | null {
  const match = (job: ChatJobSnapshot) =>
    (workspacePath === undefined || job.workspacePath === workspacePath) &&
    (threadId === undefined || job.threadId === threadId)
  const memory = [...jobs.values()]
    .filter(match)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (memory) return structuredClone(memory)
  try {
    const path =
      workspacePath !== undefined && threadId !== undefined
        ? threadPath(workspacePath, threadId)
        : latestPath()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    const job = value.status ? (value as ChatJobSnapshot) : getChatJob(value.id)
    if (!job || (!active(job) && Date.parse(job.updatedAt) < Date.now() - MAX_AGE_MS)) return null
    return match(job) ? (jobs.has(job.id) ? structuredClone(job) : recovered(job)) : null
  } catch {
    return null
  }
}
export function getChatJob(id: string): ChatJobSnapshot | null {
  const memory = jobs.get(id)
  if (memory) return structuredClone(memory)
  const legacy = join(root(), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  for (const path of [jobPath(id), legacy]) {
    try {
      const job = JSON.parse(readFileSync(path, 'utf8')) as ChatJobSnapshot
      if (job.id === id) return recovered(job)
    } catch {
      /* try legacy location */
    }
  }
  return null
}
export async function flushChatJobs(): Promise<void> {
  for (const [id, timer] of persistTimers) {
    clearTimeout(timer)
    const job = jobs.get(id)
    if (job) persistLater(job)
  }
  persistTimers.clear()
  await persistGate
}
