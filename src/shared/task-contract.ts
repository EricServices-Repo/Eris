import type { AgentToolsCeiling, ChatIntent } from './settings-schema'

/** What the user asked to receive, independent of which worker produces it. */
export type RequestedArtifact =
  'explanation' | 'code-example' | 'design' | 'plan' | 'review' | 'patch' | 'execution-report'

/** Where the artifact lands. Only workspace and new-project destinations imply edits. */
export type ArtifactDestination = 'chat' | 'workspace' | 'new-project'

/** One separately checkable part of the request, in the order the user gave it. */
export interface TaskObligation {
  id: string
  kind: 'answer' | 'implementation' | 'tests' | 'verification' | 'design' | 'plan' | 'review'
  text: string
}

/** How the resolver reached the final intent. Stable rule IDs, not prose. */
export interface IntentResolution {
  intent: ChatIntent
  initialIntent: ChatIntent
  source: 'bypass' | 'semantic' | 'fallback' | 'forced'
  /** Bypass rule, semantic acceptance, or the fallback rule that produced the intent. */
  rule: string
  confidence?: number
  failure?:
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
    | 'malformed-json'
    | 'schema-invalid'
    | 'low-confidence'
  /** Set when a conservative rule changed the intent the resolver would otherwise return. */
  downgrade?: { from: ChatIntent; to: ChatIntent; rule: string }
  durationMs: number
}

/** The single resolved reading of a request that routing, prompts and outcome checks share. */
export interface TaskInterpretation {
  revision: number
  artifact: RequestedArtifact
  destination: ArtifactDestination
  obligations: TaskObligation[]
  /** Explicit language and framework requirements from the request text. */
  language: string | null
  frameworks: string[]
  /** Request explicitly forbids workspace edits or commands ("do not edit"). */
  forbidsMutation: boolean
  route: { heuristicRule: string; overrides: string[] }
  resolution?: IntentResolution
}

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
  /** Absent on contracts saved before interpretations existed; read via interpretationOf. */
  interpretation?: TaskInterpretation
}

const ARTIFACT_FOR_DELIVERABLE: Record<TaskContract['deliverable'], RequestedArtifact> = {
  answer: 'explanation',
  review: 'review',
  plan: 'plan',
  patch: 'patch',
  'execution-report': 'execution-report'
}

/** Compatibility default for contracts persisted before interpretations were recorded. */
export function interpretationOf(contract: TaskContract): TaskInterpretation {
  if (contract.interpretation) return contract.interpretation
  const artifact = ARTIFACT_FOR_DELIVERABLE[contract.deliverable]
  return {
    revision: contract.revision,
    artifact,
    destination: artifact === 'patch' ? 'workspace' : 'chat',
    obligations: [],
    language: null,
    frameworks: [],
    forbidsMutation: false,
    route: { heuristicRule: 'legacy', overrides: [] }
  }
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
  const interpretation = contract.interpretation
  if (interpretation) {
    if (interpretation.destination !== 'chat' && !authority.edit)
      conflicts.push('A workspace destination requires edit authority.')
    if (interpretation.artifact === 'patch' && deliverable !== 'patch')
      conflicts.push('A patch artifact requires a patch deliverable.')
    if (interpretation.forbidsMutation && (authority.edit || authority.execute === 'approved'))
      conflicts.push('The request forbids changes, but the contract grants them.')
  }
  return conflicts
}
