import { atomicEvidenceJson, readEvidence } from './evidence-records'
import { AgentRunSchema } from './evidence-schemas'
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
  const path = lastRunPath(workspacePath)
  suppressWatcherFor(path)
  atomicEvidenceJson(path, { ...run, updatedAt: new Date().toISOString() })
}

export function loadLastAgentRun(workspacePath: string | null): AgentRunRecord | null {
  if (!workspacePath) return null
  const path = lastRunPath(workspacePath)
  return readEvidence(path, (value) => AgentRunSchema.parse(value) as AgentRunRecord)
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
