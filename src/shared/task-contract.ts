import type { AgentToolsCeiling, ChatIntent } from './settings-schema'

export interface TaskContract {
  version: 2
  taskId: string
  parentTaskId?: string
  revision: number
  threadId: string | null
  originalText: string
  intent: ChatIntent
  deliverable: 'answer' | 'review' | 'plan' | 'patch' | 'execution-report'
  scope: {
    workspaceRoot: string | null
    projectRoot: string | null
    projectId: string | null
    state: 'resolved' | 'ambiguous' | 'missing'
    candidates: string[]
  }
  authority: {
    tools: AgentToolsCeiling
    edit: boolean
    execute: 'none' | 'verification' | 'approved'
    externalEffects: boolean
  }
  skillIds?: string[]
  recommendations: Array<{ id: string; text: string; source: string }>
  acceptanceCriteria: string[]
}

/** A worker or recovery route may reduce authority, never increase it. */
export function intersectToolPolicy(
  policy: AgentToolsCeiling,
  contract: TaskContract
): AgentToolsCeiling {
  const levels: AgentToolsCeiling[] = ['none', 'read', 'edit', 'full']
  return levels[Math.min(levels.indexOf(policy), levels.indexOf(contract.authority.tools))]!
}
