import type { ChatIntent } from './settings-schema'
import type { AgentHandoffPacket, AgentRouteStep, BlackboardStatus } from './agent-orchestration'

export type BackgroundJobStatus =
  'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'merged' | 'discarded'

export interface BackgroundJobToolEvent {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  effect?: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
  changedResources?: string[]
  durationMs?: number
  failure?: { code: string; retryable: boolean; cause?: string }
  detail: string
  at: string
}

/** Which limit stopped a task tree. */
export type TaskTreeLimit = 'depth' | 'cycle' | 'agents' | 'steps' | 'deadline'

/** Where a job sits in the tree its root started. Saved, so a restart cannot reset it. */
export interface TaskTree {
  rootId: string
  depth: number
  /** Agent and goal fingerprints of every ancestor, root first. */
  ancestry: string[]
  deadlineAt: string
}

/** Work across the whole tree, as opposed to `step`, which is this job's own count. */
export interface TaskTreeUsage {
  agents: number
  steps: number
  depth: number
}

export interface BackgroundJob {
  outcome?: {
    receipt: import('./child-outcome').ChildOutcome
    dependencies?: import('./context-evidence').ContextEvidence
  }
  /** Import targets, separate from the immutable source conversation identity. */
  chatImports?: Array<{ workspaceKey: string; threadId: string }>

  id: string
  workspacePath: string
  worktreePath: string
  branch: string
  goal: string
  /** Model selected in the UI (may differ from toolsModel after escalate) */
  model: string
  agentId: string
  agentName?: string
  intent?: ChatIntent
  routeReason?: string
  chatModel?: string
  toolsModel?: string
  source?: 'panel' | 'chat' | 'delegate'
  sourceThreadId?: string | null
  /** Parent job when spawned via delegate_to_agent */
  parentId?: string | null
  /** Child job ids spawned by this job */
  childIds?: string[]
  /** Absent on jobs saved before trees were budgeted. */
  tree?: TaskTree
  treeUsage?: TaskTreeUsage
  /** Set when a job first runs: a job that never ran spends none of its tree's budget. */
  startedAt?: string
  /** The limit that stopped this job or refused its delegation. */
  budgetExhausted?: TaskTreeLimit
  /** Structured handoff that created this job */
  handoff?: AgentHandoffPacket | null
  /** Short claim shown on the blackboard */
  claim?: string | null
  /** Derived UI status (blocked, needs-approval, ready-to-merge, …) */
  blackboard?: BlackboardStatus
  /** Plan / escalate / reroute / delegate history */
  routeHistory?: AgentRouteStep[]
  escalateCount?: number
  rerouteCount?: number
  waitReason?: 'children' | 'approval' | 'question' | null
  destinationBranch?: string
  baseSha?: string
  /** A discard could not finish because agents were still stopping, so the worktree stays. */
  worktreeRetained?: boolean
  integration?: { state: 'shared-parent' | 'integrated'; commit?: string; at: string }
  status: BackgroundJobStatus
  step: number
  actionLog: string[]
  filesTouched: string[]
  /** Cloud jobs: patch bundle ready to apply into the workspace */
  hasArtifacts?: boolean
  artifactsTruncated?: boolean
  resumable?: boolean
  prUrl?: string
  artifactCount?: number
  answer: string
  /** Latest status line from the agent loop */
  liveStatus?: string | null
  /** Recent tool calls (newest last) */
  recentTools?: BackgroundJobToolEvent[]
  /** Tail of thinking stream for the inbox */
  thinkingTail?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type BackgroundJobEvent =
  { type: 'upsert'; job: BackgroundJob } | { type: 'removed'; id: string }

export interface EnqueueBackgroundJobRequest {
  goal: string
  model: string
  /** Omit or null for auto routing */
  agentId?: string | null
  mode?: 'ask' | 'agent'
  source?: 'panel' | 'chat' | 'delegate'
  sourceThreadId?: string | null
  forceRoute?: 'tools' | 'answer'
  parentId?: string | null
  /** Inherit parent's worktree/branch (specialists on same branch) */
  inheritWorktree?: boolean
  handoff?: AgentHandoffPacket | null
  claim?: string | null
}
