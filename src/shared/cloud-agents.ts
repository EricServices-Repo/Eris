/**
 * Public Cloud Agent endpoint for every Eris install.
 * TLS on :443. nginx on the server proxies this to the container upstream.
 * The client verifies the certificate; it does not skip TLS checks.
 */
export const CLOUD_AGENTS_BASE_URL = 'https://agents.ericservic.es:443'

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
  ownerId?: string
  plan?: 'free' | 'pro'
  repoUrl?: string | null
  branch?: string | null
  openPr?: boolean
  prUrl?: string | null
  liveStatus: string
  answer: string
  error?: string
  filesTouched: string[]
  /** Patch bundle available via GET /v1/jobs/:id/artifacts */
  hasArtifacts?: boolean
  artifactCount?: number
  artifactsTruncated?: boolean
  truncatedReasons?: string[]
  recentTools: CloudJobToolEvent[]
  thinkingTail: string
  step?: number
  resumable?: boolean
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface CloudJobArtifactFile {
  path: string
  content: string
  before: string | null
}

export interface CloudJobArtifacts {
  ok?: boolean
  jobId: string
  createdAt: string
  files: CloudJobArtifactFile[]
  truncated: boolean
  truncatedReasons?: string[]
  totalBytes: number
}

export interface CloudHealth {
  ok: boolean
  service: string
  version: string
  llmConfigured: boolean
  /** Worker reports inference can take jobs (local model ready or remote override). */
  ready?: boolean
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
  authRequired?: boolean
  error?: string
  /**
   * True when Eris has a linked EricServic.es account + device token.
   * Cloud Agents require this; omit/false means use local only.
   */
  authenticated?: boolean
}

export interface EnqueueCloudJobRequest {
  goal: string
  agentId?: string | null
  model?: string | null
  repoUrl?: string | null
  branch?: string | null
  /** Short-lived GitHub PAT for private clone / optional PR (never logged) */
  githubToken?: string | null
  /** When true and repoUrl is set, cloud worker attempts push + PR */
  openPr?: boolean
  claim?: string | null
  /** Continue from a previous cloud job checkpoint */
  resumeFromJobId?: string | null
  /** Relative workspace files to seed the cloud workspace */
  files?: Array<{ path: string; content: string }>
}

/**
 * Why Eris should skip Cloud and start a local worktree agent.
 * Auth is required; otherwise only hard cloud failures (not "model still downloading").
 */
export type CloudAgentsFallbackReason =
  | 'not-authenticated'
  | 'unreachable'
  | 'model-error'
  | 'not-configured'

export function cloudAgentsFallbackReason(
  health: CloudHealth | null | undefined
): CloudAgentsFallbackReason | null {
  if (!health) return 'unreachable'
  // Cloud Agents require a signed-in EricServic.es account (linked + device token).
  if (health.authenticated !== true) return 'not-authenticated'
  if (!health.ok) return 'unreachable'
  if (health.localModel?.status === 'error') return 'model-error'
  // Remote override path only: missing/invalid LLM config is a cloud issue.
  if (health.inference === 'remote' && health.llmConfigured === false) return 'not-configured'
  return null
}

/**
 * Prefer Cloud Agents only when the user is authenticated and the worker is usable.
 * Matches server accept policy: jobs may enqueue while the GGUF is still downloading.
 */
export function shouldUseCloudAgents(health: CloudHealth | null | undefined): boolean {
  return cloudAgentsFallbackReason(health) === null
}

/** True when the cloud worker is fully ready for immediate inference (UI green state). */
export function isCloudAgentsReady(health: CloudHealth | null | undefined): boolean {
  if (!shouldUseCloudAgents(health)) return false
  if (typeof health!.ready === 'boolean') return health!.ready
  if (health!.inference === 'remote') return true
  // Local GGUF path: green only once the model file is loaded.
  return !health!.localModel || health!.localModel.status === 'ready'
}

export function cloudAgentsStatusLabel(health: CloudHealth | null | undefined): string {
  if (!health) return 'Cloud: checking…'
  const fallback = cloudAgentsFallbackReason(health)
  if (fallback === 'not-authenticated') {
    return 'Cloud: sign in (Settings → Account) · using local'
  }
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
