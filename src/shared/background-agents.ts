import type { ChatIntent } from './settings-schema'
import type {
  AgentHandoffPacket,
  AgentRouteStep,
  BlackboardStatus
} from './agent-orchestration'

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'merged'
  | 'discarded'

export interface BackgroundJobToolEvent {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  detail: string
  at: string
}

export interface BackgroundJob {
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
  status: BackgroundJobStatus
  step: number
  actionLog: string[]
  filesTouched: string[]
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
  | { type: 'upsert'; job: BackgroundJob }
  | { type: 'removed'; id: string }

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
