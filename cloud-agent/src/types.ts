export type CloudJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'

export interface CloudJobToolEvent {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
  at: string
}

export interface CloudJobFile {
  path: string
  content: string
}

export interface CloudJobCreateRequest {
  goal: string
  agentId?: string | null
  model?: string | null
  /** Optional public or tokenized git clone URL */
  repoUrl?: string | null
  branch?: string | null
  /** Small workspace overlay (path → content) when not cloning */
  files?: CloudJobFile[]
  claim?: string | null
  source?: 'eris' | 'api'
  clientId?: string | null
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
  /** Patch bundle available via GET /v1/jobs/:id/artifacts */
  hasArtifacts?: boolean
  artifactCount?: number
  recentTools: CloudJobToolEvent[]
  thinkingTail: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface CloudHealth {
  ok: boolean
  /** Process is up; model may still be downloading. */
  service: 'eris-cloud-agent'
  version: string
  llmConfigured: boolean
  /** True when inference can accept jobs (local ready or remote override). */
  ready?: boolean
  /** Local GGUF status inside the container */
  localModel?: {
    status: 'missing' | 'downloading' | 'ready' | 'error'
    modelId: string
    modelName: string
    error?: string | null
    /** cuda | vulkan | metal | false once loaded */
    gpu?: string | false | null
  }
  /** Requested GPU mode from ERIS_CLOUD_GPU */
  gpuMode?: 'auto' | 'cuda' | 'vulkan' | 'false'
  inference?: 'local' | 'remote'
  maxParallel: number
  running: number
  queued: number
}
