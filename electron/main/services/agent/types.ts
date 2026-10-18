import type { GeneratedImageAsset } from '../../../../src/shared/image-generation'
export type AgentChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type AgentMode = 'ask' | 'agent'

export type AgentToolEvent = {
  id: string
  name: string
  path?: string
  status: 'running' | 'ok' | 'error'
  effect?: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
  changedResources?: string[]
  durationMs?: number
  failure?: { code: string; retryable: boolean }
  detail: string
}

export type AgentDiffEvent = {
  checkpointId: string
  /** Index into the checkpoint ops list for per-file undo */
  opIndex: number
  path: string
  before: string | null
  after: string
  op: 'write' | 'delete' | 'rename' | 'mkdir' | 'binary'
}

export type AgentRunnerEvent =
  | { type: 'asset'; asset: GeneratedImageAsset }
  | { type: 'thinking'; text: string }
  | { type: 'answer'; text: string; replace?: boolean }
  | { type: 'tool'; tool: AgentToolEvent }
  | { type: 'diff'; diff: AgentDiffEvent }
  | { type: 'checkpoint'; checkpointId: string }
  | { type: 'workspace-changed' }
  | { type: 'status'; text: string }
  | { type: 'model'; model: string }
  | { type: 'terminal'; text: string }
  | {
      type: 'progress'
      step: number
      actionLog: string[]
      filesTouched: string[]
      /** Set when the loop stopped before finishing (verify budget or an abort). */
      incomplete?: boolean
    }
  | {
      /** Persisted agent-session step (after a tool batch) for resume/rewind. */
      type: 'session-step'
      step: number
      opThrough: number
      summary: string
      actionLog: string[]
      filesTouched: string[]
      workerMessages: AgentChatMessage[]
    }
  | {
      type: 'adapt'
      kind: 'escalate' | 'reroute' | 'delegate'
      reason: string
      agentId?: string
      agentName?: string
      model?: string
      childJobId?: string
    }
  | {
      type: 'delegation'
      delegation: {
        id: string
        agentId: string
        agentName: string
        goal: string
        status: 'running' | 'done' | 'failed'
        tools: Array<{ name: string; path?: string; status: string }>
        result: string
      }
    }

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  raw: string
}
