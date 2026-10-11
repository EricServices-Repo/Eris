export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'merged'
  | 'discarded'

export interface BackgroundJob {
  id: string
  workspacePath: string
  worktreePath: string
  branch: string
  goal: string
  model: string
  agentId: string
  status: BackgroundJobStatus
  step: number
  actionLog: string[]
  filesTouched: string[]
  answer: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type BackgroundJobEvent =
  | { type: 'upsert'; job: BackgroundJob }
  | { type: 'removed'; id: string }
