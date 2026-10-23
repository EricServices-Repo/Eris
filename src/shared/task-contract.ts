import type { AgentToolsCeiling, ChatIntent } from './settings-schema'

/** What the user asked to receive, independent of which worker produces it. */
export type RequestedArtifact =
  'explanation' | 'code-example' | 'design' | 'plan' | 'review' | 'patch' | 'execution-report'

/**
 * generic: answerable without the project; selected-project: the work lands in
 * the open project; named-target: the user named a project; unverified: the
 * project may be relevant, but nothing has shown that it is.
 */
export type ScopeApplicability = 'generic' | 'selected-project' | 'named-target' | 'unverified'

/**
 * Whether the reply must cite inspected project sources. Derived from applicability,
 * never from the folder merely existing: required for project work, optional when the
 * project may be relevant, none when the request is answerable without it.
 */
export type EvidenceRequirement = 'required' | 'optional' | 'none'

export function evidenceRequirementFor(
  applicability: ScopeApplicability | undefined
): EvidenceRequirement {
  if (applicability === 'generic') return 'none'
  if (applicability === 'unverified') return 'optional'
  // Contracts saved before applicability existed keep their prior, grounded behavior.
  return 'required'
}

/** Languages and frameworks observed in the selected project's manifests. */
export interface ProjectStack {
  languages: string[]
  frameworks: string[]
}

/** Where the artifact lands. Only workspace and new-project destinations imply edits. */
export type ArtifactDestination = 'chat' | 'workspace' | 'new-project'

/** One separately checkable part of the request, in the order the user gave it. */
export interface TaskObligation {
  id: string
  kind:
    | 'answer'
    | 'implementation'
    | 'tests'
    | 'verification'
    | 'design'
    | 'plan'
    | 'review'
    | 'constraint'
  text: string
  /**
   * A named part of a multi-part deliverable (“simple”, “robust”, “comparison”). Each
   * component is satisfied on its own; one version never completes another.
   */
  component?: string
  /** The user's exact phrase this obligation came from, in the request text. */
  source?: { text: string; start: number; end: number }
}

/** A recommendation that a later turn can refer to without repeating it. */
export interface TaskRecommendation {
  /** Stable for the same text in the same source answer. */
  id: string
  text: string
  /** Digest of the answer that offered it. */
  source: string
  /** Workspace paths the recommendation names. */
  targets?: string[]
  /** The heading it appeared under, lowercased. */
  section?: string
}

/** How one selected recommendation ended; every selected item gets exactly one. */
export interface RecommendationStatus {
  id: string
  state: 'completed' | 'deferred' | 'blocked' | 'pending'
  reason?: string
}

export interface TaskTurnResult {
  terminal: 'complete' | 'incomplete' | 'error' | 'stopped'
  /** Recommendations offered by this turn's answer. */
  offeredRecommendations: TaskRecommendation[]
  changedFiles: string[]
  answerDigest: string
  /** Per-recommendation accounting for a turn that implemented earlier recommendations. */
  recommendationStatus?: RecommendationStatus[]
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
  /** Language being converted from (“convert this Python to TypeScript”); language is the target. */
  sourceLanguage?: string | null
  /** Several explicitly named languages without a stated target. */
  languageAmbiguity?: string[]
  /** Request explicitly forbids workspace edits ("do not edit", "without changing files"). */
  forbidsMutation: boolean
  /**
   * Each effect the request forbids, with the phrase that forbade it. Absent on
   * contracts saved before effects were separated, and when nothing is forbidden.
   */
  constraints?: {
    edit: boolean
    verification: boolean
    execution: boolean
    commit: boolean
    external: boolean
    trace: Array<{
      phrase: string
      effects: Array<'edit' | 'verification' | 'execution' | 'commit' | 'external'>
    }>
  }
  /** Observed project stack, compared with the requested one. */
  projectStack?: ProjectStack | null
  stackFit?: 'match' | 'mismatch' | 'unknown' | 'not-applicable'
  /** A requested concept that belongs to another ecosystem, e.g. React error boundaries in Rust. */
  conceptFit?: { concept: string; ecosystem: string; requestedLanguage: string } | null
  route: { heuristicRule: string; overrides: string[] }
  resolution?: IntentResolution
  /**
   * Structured provenance for the artifact and scope decisions: the rule that chose
   * each and the alternatives it rejected. Program provenance, not model reasoning.
   */
  trace?: {
    version: 1
    artifactRule: string
    rejected: string[]
    scopeRule?: string
    /** Explicit clauses past the extraction bound; they remain only in the request text. */
    unparsedRequirements?: number
  }
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
    /**
     * Whether the resolved project is evidence for this request. A resolved root
     * only means the folder exists; it does not mean it implements the topic.
     */
    applicability?: ScopeApplicability
  }
  authority: {
    tools: AgentToolsCeiling
    edit: boolean
    execute: 'none' | 'verification' | 'approved'
    externalEffects: boolean
  }
  skillIds?: string[]
  /** Recommendations this follow-up refers to (“implement those”), resolved at intake. */
  recommendations: TaskRecommendation[]
  /** How the follow-up selected them: all, by number, by name, or all except some. */
  recommendationSelection?: {
    mode: 'all' | 'numbered' | 'named' | 'except'
    excludedIds: string[]
    unresolved?: string
  }
  acceptanceCriteria: string[]
  /** Set when this turn continues an earlier task in the same thread and project. */
  continuation?: {
    priorTaskId: string
    /** Files the prior turn actually changed, for “what did you change?”. */
    changedFiles: string[]
    /** How referenced recommendations were found. */
    recommendationSource: 'prior-task' | 'prior-answer-prose' | 'none'
  }
  /** What this turn produced; recorded after it ends and read by the next turn. */
  result?: TaskTurnResult
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
    const constraints = interpretation.constraints
    if (constraints) {
      if (constraints.edit && authority.edit)
        conflicts.push('The request forbids edits, but the contract grants them.')
      if ((constraints.execution || constraints.verification) && authority.execute !== 'none')
        conflicts.push('The request forbids running commands, but the contract grants it.')
    } else if (
      interpretation.forbidsMutation &&
      (authority.edit || authority.execute === 'approved')
    )
      conflicts.push('The request forbids changes, but the contract grants them.')
  }
  return conflicts
}
