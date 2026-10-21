export type ChatJobStatus = 'running' | 'done' | 'stopped' | 'failed' | 'incomplete'

export type ChatJobEvent = {
  sequence: number
  at: string
  channel: string
  payload: Record<string, unknown>
}

export type ChatJobSnapshot = {
  id: string
  workspacePath: string | null
  threadId: string | null
  goal: string
  status: ChatJobStatus
  statusText: string | null
  answer: string
  model: string | null
  startedAt: string
  updatedAt: string
  events: ChatJobEvent[]
}
