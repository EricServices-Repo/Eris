import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { workspaceConfigDir } from './paths'
import { suppressWatcherFor } from './workspace-watcher'

export type AgentRunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'incomplete' | 'dismissed'

export interface AgentRunRecord {
  id: string
  requestId: string
  goal: string
  agentId: string
  mode: 'ask' | 'agent'
  checkpointId: string | null
  /** Linked `.eris/sessions/{id}` for step resume / rewind. */
  sessionId?: string | null
  status: AgentRunStatus
  step: number
  actionLog: string[]
  filesTouched: string[]
  startedAt: string
  updatedAt: string
  error?: string
}

const RESUMABLE: AgentRunStatus[] = ['running', 'stopped', 'failed', 'incomplete']

function runsDir(workspacePath: string): string {
  return join(workspaceConfigDir(workspacePath), 'runs')
}

function lastRunPath(workspacePath: string): string {
  return join(runsDir(workspacePath), 'last.json')
}

export function saveAgentRun(workspacePath: string, run: AgentRunRecord): void {
  try {
    mkdirSync(runsDir(workspacePath), { recursive: true })
    const path = lastRunPath(workspacePath)
    const tmp = `${path}.tmp`
    suppressWatcherFor(tmp)
    suppressWatcherFor(path)
    writeFileSync(tmp, JSON.stringify({ ...run, updatedAt: new Date().toISOString() }, null, 2))
    renameSync(tmp, path)
  } catch {
    // persistence is best-effort
  }
}

export function loadLastAgentRun(workspacePath: string | null): AgentRunRecord | null {
  if (!workspacePath) return null
  const path = lastRunPath(workspacePath)
  if (!existsSync(path)) return null
  try {
    const run = JSON.parse(readFileSync(path, 'utf8')) as AgentRunRecord
    return run && typeof run.goal === 'string' && Array.isArray(run.actionLog) ? run : null
  } catch {
    return null
  }
}

/** Last run if it stopped before finishing and has made progress. */
export function loadResumableRun(
  workspacePath: string | null,
  activeRequestId?: string | null
): AgentRunRecord | null {
  const run = loadLastAgentRun(workspacePath)
  if (!run || !RESUMABLE.includes(run.status)) return null
  if (run.status === 'running' && activeRequestId && run.requestId === activeRequestId) return null
  if (run.actionLog.length === 0) return null
  return run
}

export function setAgentRunStatus(
  workspacePath: string | null,
  id: string,
  status: AgentRunStatus
): boolean {
  if (!workspacePath) return false
  const run = loadLastAgentRun(workspacePath)
  if (!run || run.id !== id) return false
  saveAgentRun(workspacePath, { ...run, status })
  return true
}
