/**
 * Public Cloud Agent endpoint for every Eris install.
 * No user configuration — clients hit agents.ericservic.es:6443 (Docker listen port).
 */
export const CLOUD_AGENTS_BASE_URL = 'https://agents.ericservic.es:6443'

export const CLOUD_AGENTS_HEALTH_PATH = '/v1/health'
export const CLOUD_AGENTS_JOBS_PATH = '/v1/jobs'

export type CloudJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

export interface CloudJobToolEvent {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
  at: string
}

export interface CloudJob {
  id: string
  goal: string
  agentId: string
  agentName: string
  model: string
  status: CloudJobStatus
  claim: string
  repoUrl?: string | null
  branch?: string | null
  liveStatus: string
  answer: string
  error?: string
  filesTouched: string[]
  recentTools: CloudJobToolEvent[]
  thinkingTail: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface CloudHealth {
  ok: boolean
  service: string
  version: string
  llmConfigured: boolean
  localModel?: {
    status: 'missing' | 'downloading' | 'ready' | 'error'
    modelId: string
    modelName: string
    error?: string | null
  }
  inference?: 'local' | 'remote'
  maxParallel: number
  running: number
  queued: number
  publicBaseUrl?: string
  error?: string
}

export interface EnqueueCloudJobRequest {
  goal: string
  agentId?: string | null
  model?: string | null
  repoUrl?: string | null
  branch?: string | null
  claim?: string | null
  /** Relative workspace files to seed the cloud workspace */
  files?: Array<{ path: string; content: string }>
}
