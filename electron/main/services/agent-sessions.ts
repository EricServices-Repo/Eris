import { atomicEvidenceJson, readEvidence } from './evidence-records'
import { z } from 'zod'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { workspaceConfigDir } from './paths'
import { suppressWatcherFor } from './workspace-watcher'
import type { AgentChatMessage } from './agent/types'

export type AgentSessionStatus =
  'running' | 'done' | 'stopped' | 'failed' | 'incomplete' | 'dismissed'

export interface AgentSessionStep {
  step: number
  /** Ops kept in the file checkpoint after this step (0 = no mutations yet). */
  opThrough: number
  summary: string
  actionLog: string[]
  filesTouched: string[]
  /** Compacted worker transcript so resume can continue mid-run. */
  workerMessages: AgentChatMessage[]
  ts: string
}

export interface AgentSessionMeta {
  id: string
  requestId: string
  threadId: string | null
  goal: string
  agentId: string
  mode: 'ask' | 'agent'
  checkpointId: string | null
  status: AgentSessionStatus
  step: number
  parentSessionId: string | null
  branchFromStep: number | null
  startedAt: string
  updatedAt: string
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MetaSchema = z
  .object({
    id: z.string().regex(SESSION_ID),
    requestId: z.string().min(1).max(256),
    threadId: z.string().nullable(),
    goal: z.string().max(128000),
    agentId: z.string(),
    mode: z.enum(['ask', 'agent']),
    checkpointId: z.string().nullable(),
    status: z.enum(['running', 'done', 'stopped', 'failed', 'incomplete', 'dismissed']),
    step: z.number().int().nonnegative(),
    parentSessionId: z.string().nullable(),
    branchFromStep: z.number().int().nonnegative().nullable(),
    startedAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough()
const StepSchema = z
  .object({
    step: z.number().int().nonnegative(),
    opThrough: z.number().int().nonnegative(),
    summary: z.string().max(128000),
    actionLog: z.array(z.string()).max(10000),
    filesTouched: z.array(z.string()).max(10000),
    workerMessages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant', 'tool']),
            content: z.string().max(1_000_000)
          })
          .passthrough()
      )
      .max(1000),
    ts: z.string()
  })
  .passthrough()
const MAX_WORKER_CHARS = 48_000
const MAX_STEPS_KEPT = 40
const MAX_SESSIONS_KEPT = 12

function sessionsRoot(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'sessions')
}

function sessionDir(workspacePath: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session identity')
  return join(sessionsRoot(workspacePath), id)
}

function metaPath(workspacePath: string, id: string): string {
  return join(sessionDir(workspacePath, id), 'meta.json')
}

function stepsDir(workspacePath: string, id: string): string {
  return join(sessionDir(workspacePath, id), 'steps')
}

function stepPath(workspacePath: string, id: string, step: number): string {
  return join(stepsDir(workspacePath, id), `${step}.json`)
}

function writeJsonAtomic(path: string, data: unknown): void {
  suppressWatcherFor(path)
  atomicEvidenceJson(path, data)
}

/** Cap worker transcript so session files stay small. */
export function compactWorkerMessagesForSession(
  messages: AgentChatMessage[],
  maxChars = MAX_WORKER_CHARS
): AgentChatMessage[] {
  if (messages.length === 0) return []
  let total = 0
  const out: AgentChatMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const len = m.content?.length ?? 0
    if (out.length > 0 && total + len > maxChars) break
    out.push({ ...m })
    total += len
  }
  out.reverse()
  // Never persist an orphaned tool result after trimming the call that owns it.
  while (out[0]?.role === 'tool') out.shift()
  const pinned = messages.find((message) => message.role === 'system')
  if (
    pinned &&
    !out.includes(pinned) &&
    !out.some((message) => message.role === 'system' && message.content === pinned.content)
  )
    out.unshift({ ...pinned })
  if (out.length < messages.length) {
    out.splice(pinned ? 1 : 0, 0, {
      role: 'system',
      content: `[Eris] Earlier session context trimmed (${messages.length - out.length} messages). Continue from the preserved turns.`
    })
  }
  return out
}

export function createAgentSession(
  workspacePath: string,
  input: {
    requestId: string
    threadId?: string | null
    goal: string
    agentId: string
    mode: 'ask' | 'agent'
    checkpointId?: string | null
    parentSessionId?: string | null
    branchFromStep?: number | null
  }
): AgentSessionMeta {
  const id = randomUUID()
  const now = new Date().toISOString()
  const meta: AgentSessionMeta = {
    id,
    requestId: input.requestId,
    threadId: input.threadId ?? null,
    goal: input.goal,
    agentId: input.agentId,
    mode: input.mode,
    checkpointId: input.checkpointId ?? null,
    status: 'running',
    step: 0,
    parentSessionId: input.parentSessionId ?? null,
    branchFromStep: input.branchFromStep ?? null,
    startedAt: now,
    updatedAt: now
  }
  mkdirSync(stepsDir(workspacePath, id), { recursive: true })
  writeJsonAtomic(metaPath(workspacePath, id), meta)
  pruneOldSessions(workspacePath, MAX_SESSIONS_KEPT)
  return meta
}

export function loadAgentSession(
  workspacePath: string | null,
  id: string
): AgentSessionMeta | null {
  if (!workspacePath || !SESSION_ID.test(id)) return null
  return readEvidence(metaPath(workspacePath, id), (value) => {
    const meta = MetaSchema.parse(value)
    if (meta.id !== id) throw new Error('Session metadata belongs to another identity')
    return meta as AgentSessionMeta
  })
}

export function saveAgentSession(workspacePath: string, meta: AgentSessionMeta): void {
  try {
    mkdirSync(sessionDir(workspacePath, meta.id), { recursive: true })
    writeJsonAtomic(metaPath(workspacePath, meta.id), {
      ...meta,
      updatedAt: new Date().toISOString()
    })
  } catch {
    // best-effort
  }
}

export function appendSessionStep(
  workspacePath: string,
  sessionId: string,
  step: Omit<AgentSessionStep, 'ts'> & { ts?: string }
): AgentSessionStep | null {
  const meta = loadAgentSession(workspacePath, sessionId)
  if (!meta) return null
  const record: AgentSessionStep = {
    step: step.step,
    opThrough: step.opThrough,
    summary: step.summary.slice(0, 240),
    actionLog: step.actionLog.slice(-80),
    filesTouched: [...new Set(step.filesTouched)].slice(-120),
    workerMessages: compactWorkerMessagesForSession(step.workerMessages),
    ts: step.ts || new Date().toISOString()
  }
  try {
    mkdirSync(stepsDir(workspacePath, sessionId), { recursive: true })
    writeJsonAtomic(stepPath(workspacePath, sessionId, record.step), record)
    saveAgentSession(workspacePath, {
      ...meta,
      step: Math.max(meta.step, record.step),
      checkpointId: meta.checkpointId
    })
    pruneSessionSteps(workspacePath, sessionId, MAX_STEPS_KEPT)
    return record
  } catch {
    return null
  }
}

export function loadSessionStep(
  workspacePath: string | null,
  sessionId: string,
  step: number
): AgentSessionStep | null {
  if (!workspacePath || !SESSION_ID.test(sessionId) || !Number.isSafeInteger(step) || step < 0)
    return null
  return readEvidence(stepPath(workspacePath, sessionId, step), (value) => {
    const record = StepSchema.parse(value)
    if (record.step !== step) throw new Error('Session step identity mismatch')
    return record as AgentSessionStep
  })
}

export function listSessionSteps(
  workspacePath: string | null,
  sessionId: string
): Array<Pick<AgentSessionStep, 'step' | 'opThrough' | 'summary' | 'ts' | 'filesTouched'>> {
  if (!workspacePath) return []
  const dir = stepsDir(workspacePath, sessionId)
  if (!existsSync(dir)) return []
  const out: Array<
    Pick<AgentSessionStep, 'step' | 'opThrough' | 'summary' | 'ts' | 'filesTouched'>
  > = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const n = Number(name.replace(/\.json$/, ''))
    if (!Number.isFinite(n)) continue
    const step = loadSessionStep(workspacePath, sessionId, n)
    if (step) {
      out.push({
        step: step.step,
        opThrough: step.opThrough,
        summary: step.summary,
        ts: step.ts,
        filesTouched: step.filesTouched
      })
    }
  }
  return out.sort((a, b) => a.step - b.step)
}

export function setAgentSessionStatus(
  workspacePath: string | null,
  id: string,
  status: AgentSessionStatus
): boolean {
  if (!workspacePath) return false
  const meta = loadAgentSession(workspacePath, id)
  if (!meta) return false
  saveAgentSession(workspacePath, { ...meta, status })
  return true
}

/** Fork a session at a step for branch-from-here. */
export function branchAgentSession(
  workspacePath: string,
  parentId: string,
  fromStep: number,
  requestId: string
): AgentSessionMeta | null {
  const parent = loadAgentSession(workspacePath, parentId)
  const step = loadSessionStep(workspacePath, parentId, fromStep)
  if (!parent || !step) return null
  const branched = createAgentSession(workspacePath, {
    requestId,
    threadId: parent.threadId,
    goal: parent.goal,
    agentId: parent.agentId,
    mode: parent.mode,
    checkpointId: parent.checkpointId,
    parentSessionId: parent.id,
    branchFromStep: fromStep
  })
  appendSessionStep(workspacePath, branched.id, {
    step: fromStep,
    opThrough: step.opThrough,
    summary: `Branched from step ${fromStep}: ${step.summary}`,
    actionLog: step.actionLog,
    filesTouched: step.filesTouched,
    workerMessages: step.workerMessages
  })
  return loadAgentSession(workspacePath, branched.id)
}

function pruneSessionSteps(workspacePath: string, sessionId: string, keep: number): void {
  const steps = listSessionSteps(workspacePath, sessionId)
  for (const s of steps.slice(0, Math.max(0, steps.length - keep))) {
    try {
      rmSync(stepPath(workspacePath, sessionId, s.step), { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** Unified terminal-aware idle maintenance owns session retention. */
export function pruneOldSessions(_workspacePath: string, _keep = MAX_SESSIONS_KEPT): void {}
