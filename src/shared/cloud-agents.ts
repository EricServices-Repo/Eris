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
    /** cuda | vulkan | metal | false once the GGUF runtime is loaded */
    gpu?: string | false | null
  }
  /** Requested GPU mode on the worker (ERIS_CLOUD_GPU) */
  gpuMode?: 'auto' | 'cuda' | 'vulkan' | 'false'
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

/**
 * Why Eris should skip Cloud and start a local worktree agent.
 * Only hard cloud failures — not "model still downloading".
 */
export type CloudAgentsFallbackReason = 'unreachable' | 'model-error' | 'not-configured'

export function cloudAgentsFallbackReason(
  health: CloudHealth | null | undefined
): CloudAgentsFallbackReason | null {
  if (!health?.ok) return 'unreachable'
  if (health.localModel?.status === 'error') return 'model-error'
  // Remote override path only: missing/invalid LLM config is a cloud issue.
  if (health.inference === 'remote' && health.llmConfigured === false) return 'not-configured'
  return null
}

/**
 * Prefer Cloud Agents whenever the worker is reachable and not in a hard error.
 * Matches server accept policy: jobs may enqueue while the GGUF is still downloading.
 */
export function shouldUseCloudAgents(health: CloudHealth | null | undefined): boolean {
  return cloudAgentsFallbackReason(health) === null
}

/** True when the cloud worker is fully ready for immediate inference (UI green state). */
export function isCloudAgentsReady(health: CloudHealth | null | undefined): boolean {
  if (!shouldUseCloudAgents(health)) return false
  if (health!.inference === 'remote') return true
  // Local GGUF path: green only once the model file is loaded.
  return !health!.localModel || health!.localModel.status === 'ready'
}

export function cloudAgentsStatusLabel(health: CloudHealth | null | undefined): string {
  if (!health) return 'Cloud: checking…'
  const fallback = cloudAgentsFallbackReason(health)
  if (fallback === 'unreachable') {
    return `Cloud: offline${health.error ? ` (${health.error})` : ''} · using local`
  }
  if (fallback === 'model-error') return 'Cloud: model error · using local'
  if (fallback === 'not-configured') return 'Cloud: LLM not configured · using local'
  if (health.localModel?.status === 'downloading') return 'Cloud: downloading model…'
  if (health.localModel?.status === 'missing') return 'Cloud: warming model…'
  if (isCloudAgentsReady(health)) {
    const name = health.localModel?.modelName || 'ready'
    return `Cloud: ${name}`
  }
  return 'Cloud: available'
}
