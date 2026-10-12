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
  /** Short-lived GitHub PAT for private clone / optional PR (never returned in job JSON) */
  githubToken?: string | null
  /** When true and repoUrl is set, attempt push + PR after success */
  openPr?: boolean
  /** Small workspace overlay (path → content) when not cloning */
  files?: CloudJobFile[]
  claim?: string | null
  source?: 'eris' | 'api'
  clientId?: string | null
  /** Continue a previous job from its checkpoint */
  resumeFromJobId?: string | null
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

export interface CloudHealth {
  ok: boolean
  service: 'eris-cloud-agent'
  version: string
  llmConfigured: boolean
  ready?: boolean
  localModel?: {
    status: 'missing' | 'downloading' | 'ready' | 'error'
    modelId: string
    modelName: string
    error?: string | null
    gpu?: string | false | null
  }
  gpuMode?: 'auto' | 'cuda' | 'vulkan' | 'false'
  inference?: 'local' | 'remote'
  maxParallel: number
  running: number
  queued: number
  authRequired?: boolean
}
