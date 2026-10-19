import { readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ChatJobSnapshot, ChatJobStatus } from '../../../src/shared/chat-jobs'
import { userDataRoot } from './paths'

const jobs = new Map<string, ChatJobSnapshot>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_EVENTS = 240
let persistGate: Promise<void> = Promise.resolve()

function root(): string {
  return join(userDataRoot(), 'chat-jobs')
}

function jobPath(id: string): string {
  return join(root(), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

function latestPath(): string {
  return join(root(), 'latest.json')
}

function persistNow(job: ChatJobSnapshot): void {
  const snapshot = structuredClone(job)
  persistGate = persistGate
    .then(async () => {
      await mkdir(root(), { recursive: true })
      const body = JSON.stringify(snapshot)
      const path = jobPath(snapshot.id)
      await writeFile(`${path}.tmp`, body, 'utf8')
      await rename(`${path}.tmp`, path)
      await writeFile(`${latestPath()}.tmp`, body, 'utf8')
      await rename(`${latestPath()}.tmp`, latestPath())
    })
    .catch(() => undefined)
}

function schedulePersist(job: ChatJobSnapshot): void {
  if (persistTimers.has(job.id)) return
  persistTimers.set(
    job.id,
    setTimeout(() => {
      persistTimers.delete(job.id)
      persistNow(job)
    }, 100)
  )
}

export function startChatJob(input: {
  id: string
  workspacePath: string | null
  threadId: string | null
  goal: string
}): ChatJobSnapshot {
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
  persistNow(job)
  return job
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
  } else if (channel === 'chat:status') {
    job.statusText = typeof payload.text === 'string' ? payload.text : job.statusText
  } else if (channel === 'chat:model') {
    job.model = typeof payload.model === 'string' ? payload.model : job.model
  }
  if (channel !== 'chat:thinking' && channel !== 'chat:answer') {
    job.events.push({
      sequence: (job.events.at(-1)?.sequence ?? 0) + 1,
      at: job.updatedAt,
      channel,
      payload
    })
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS)
  }
  schedulePersist(job)
}

export function finishChatJob(id: string, status: ChatJobStatus): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = status
  job.statusText = status === 'done' ? 'Done' : status === 'stopped' ? 'Stopped' : 'Failed'
  job.updatedAt = new Date().toISOString()
  const timer = persistTimers.get(id)
  if (timer) clearTimeout(timer)
  persistTimers.delete(id)
  persistNow(job)
}

export function getLatestChatJob(workspacePath?: string | null): ChatJobSnapshot | null {
  const memory = [...jobs.values()]
    .filter((job) => workspacePath === undefined || job.workspacePath === workspacePath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (memory) return structuredClone(memory)
  try {
    const parsed = JSON.parse(readFileSync(latestPath(), 'utf8')) as ChatJobSnapshot
    if (workspacePath !== undefined && parsed.workspacePath !== workspacePath) return null
    // A disk-only running record belongs to a previous process. Live jobs are always in memory.
    if (parsed.status === 'running') {
      parsed.status = 'stopped'
      parsed.statusText = 'Stopped when Eris closed'
      parsed.updatedAt = new Date().toISOString()
      persistNow(parsed)
    }
    jobs.set(parsed.id, parsed)
    return structuredClone(parsed)
  } catch {
    return null
  }
}
