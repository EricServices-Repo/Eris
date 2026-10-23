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

/**
 * Internally impossible contracts: a deliverable or acceptance rule the granted
 * authority cannot satisfy. Callers reject these before inference.
 */
export function taskContractConflicts(contract: TaskContract): string[] {
  const conflicts: string[] = []
  const { authority, deliverable } = contract
  if (deliverable === 'patch' && !authority.edit)
    conflicts.push('A patch deliverable requires edit authority.')
  if (authority.edit && authority.tools !== 'edit' && authority.tools !== 'full')
    conflicts.push('Edit authority exceeds the tool ceiling.')
  if (authority.execute === 'approved' && authority.tools !== 'full')
    conflicts.push('Approved execution requires the full tool ceiling.')
  if (authority.externalEffects && authority.tools !== 'full')
    conflicts.push('External effects require the full tool ceiling.')
  if (deliverable === 'answer' && authority.tools === 'none' && authority.execute !== 'none')
    conflicts.push('A tool-free answer cannot execute commands.')
  return conflicts
}
