/**
 * Public Cloud Agent endpoint for every Eris install.
 * Plain HTTP on :6443 — no TLS certificate required on client or server.
 */
export const CLOUD_AGENTS_BASE_URL = 'http://agents.ericservic.es:6443'

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

/** True when Eris should prefer Cloud Agents over local worktrees. */
export function isCloudAgentsReady(health: CloudHealth | null | undefined): boolean {
  if (!health?.ok) return false
  if (health.localModel?.status === 'error') return false
  if (health.inference === 'remote') return health.llmConfigured !== false
  // Default: in-container GGUF must be loaded
  return health.localModel?.status === 'ready'
}

export function cloudAgentsStatusLabel(health: CloudHealth | null | undefined): string {
  if (!health) return 'Cloud: checking…'
  if (!health.ok) return `Cloud: offline${health.error ? ` (${health.error})` : ''} · using local`
  if (health.localModel?.status === 'downloading') return 'Cloud: downloading model…'
  if (health.localModel?.status === 'missing') return 'Cloud: model missing…'
  if (health.localModel?.status === 'error') {
    return `Cloud: model error · using local`
  }
  if (isCloudAgentsReady(health)) {
    const name = health.localModel?.modelName || 'ready'
    return `Cloud: ${name}`
  }
  return 'Cloud: pending · using local'
}
