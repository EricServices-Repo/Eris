import type { ChatIntent, TurnPlan } from '../../../../src/shared/settings-schema'
import { asksToImplementChanges } from '../../../../src/shared/agent-contract'
import { evidenceRequirementFor } from '../../../../src/shared/task-contract'
import { pathsIn } from '../../../../src/shared/recommendations'
import { requestTextForIntent } from '../../../../src/shared/task-interpretation'
import { requestedFilesProblem, requiresRequestedCodeVerification } from './requested-files'
import { SourceReadEvidence, type SourceReadReceipt } from './source-read-evidence'
import type { VerifiedNoop } from './verified-noop'

export type AgentWorkflowPhase =
  'planned' | 'answering' | 'preflight' | 'executing' | 'verifying' | 'completed' | 'blocked'

export type AgentOutcomeContract = {
  intent: ChatIntent
  requiresWorkspaceEvidence: boolean
  requiresSourceRead: boolean
  requiresMutation: boolean
  requiresVerificationAfterMutation: boolean
  /**
   * Files the request or its referenced recommendations name. When present, a
   * mutation counts as progress only if it changes at least one of them.
   */
  targetFiles: string[]
}

function sameFile(changed: string, target: string): boolean {
  const a = changed.replace(/^\.\//, '')
  const b = target.replace(/^\.\//, '')
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

export type AgentWorkflowSnapshot = {
  phase: AgentWorkflowPhase
  contract: AgentOutcomeContract
  toolCalls: number
  successfulToolCalls: number
  mutations: number
  verification: 'not-run' | 'passed' | 'failed' | 'skipped'
  blockedReason?: string
  sourceEvidence?: SourceReadReceipt[]
  /** Requirements shown to be already met; distinct from changes. */
  verifiedNoops?: VerifiedNoop[]
}

/** changed: the workspace was edited. already-satisfied: verified no-op, nothing touched. */
export type OutcomeDisposition = 'changed' | 'already-satisfied' | 'none'

const TRANSITIONS: Record<AgentWorkflowPhase, ReadonlySet<AgentWorkflowPhase>> = {
  planned: new Set(['answering', 'preflight', 'blocked']),
  answering: new Set(['completed', 'blocked']),
  preflight: new Set(['executing', 'blocked']),
  executing: new Set(['verifying', 'completed', 'blocked']),
  verifying: new Set(['executing', 'completed', 'blocked']),
  completed: new Set(),
  blocked: new Set()
}

export function outcomeContractFor(plan: TurnPlan, goal = ''): AgentOutcomeContract {
  const requiresMutation = plan.task
    ? plan.task.deliverable === 'patch' && plan.task.authority.edit
    : plan.mode !== 'ask' && (plan.intent === 'edit' || asksToImplementChanges(goal))
  const targetFiles = requiresMutation
    ? [
        ...new Set([
          ...pathsIn(requestTextForIntent(plan.task?.originalText ?? goal)),
          ...(plan.task?.recommendations ?? []).flatMap((item) => item.targets ?? [])
        ])
      ]
    : []
  return {
    intent: plan.intent,
    requiresSourceRead: plan.task?.requested?.evidence === 'source-read',
    requiresWorkspaceEvidence:
      plan.task?.requested?.evidence === 'source-read' ||
      requiresMutation ||
      (plan.requiresTools &&
        !['answer', 'capability'].includes(plan.intent) &&
        (!plan.task ||
          evidenceRequirementFor(plan.task.scope.applicability) === 'required' ||
          ['run', 'verify'].includes(plan.intent))),
    requiresMutation,
    requiresVerificationAfterMutation: requiresMutation,
    targetFiles
  }
}

/**
 * Deterministic lifecycle for a single agent turn. Prompts can suggest behavior;
 * this state machine decides whether the observable outcome satisfies the turn.
 */
export class AgentWorkflow {
  private phase: AgentWorkflowPhase = 'planned'
  private toolCalls = 0
  private successfulToolCalls = 0
  private mutations = 0
  private sourceReads = 0
  private commandObservations = 0
  private mutatedFiles = new Set<string>()
  private verification: AgentWorkflowSnapshot['verification'] = 'not-run'
  private blockedReason: string | undefined
  private sourceEvidence?: SourceReadEvidence
  private verifiedNoops: VerifiedNoop[] = []

  readonly contract: AgentOutcomeContract

  constructor(private readonly plan: TurnPlan, goal = '') {
    this.contract = outcomeContractFor(plan, goal)
    if (plan.task?.scope.workspaceRoot && plan.task.scope.projectRoot)
      this.sourceEvidence=new SourceReadEvidence(plan.task)
  }

  transition(next: AgentWorkflowPhase): void {
    if (next === this.phase) return
    if (!TRANSITIONS[this.phase].has(next)) {
      throw new Error(`Invalid agent workflow transition: ${this.phase} → ${next}`)
    }
    this.phase = next
  }

  noteTool(result: { ok: boolean; mutated: boolean; name?: string; path?: string; previousPath?: string; detail?: string; range?: SourceReadReceipt['range'] }): void {
    this.toolCalls += 1
    if (result.name === 'run') this.commandObservations += 1
    if (result.ok) this.successfulToolCalls += 1
    if (result.ok && result.path && result.mutated) this.mutatedFiles.add(result.path)
    if (
      result.ok &&
      ['read_file', 'notebook_read'].includes(result.name ?? '') &&
      result.path &&
      !result.path.startsWith('.eris/') &&
      (this.sourceEvidence?.noteRead(result.path,result.detail,result.range) ?? true)
    )
      this.sourceReads += 1
    if (result.ok && result.mutated) {
      // An edit after confirmation means the confirmed source is no longer what was verified.
      if (result.path)
        this.verifiedNoops = this.verifiedNoops.filter((noop) => !sameFile(noop.path, result.path!))
      this.mutations += 1
      if (result.path) this.sourceEvidence?.noteMutation(result.path)
      if (result.previousPath) this.sourceEvidence?.noteMutation(result.previousPath,result.path)
    }
  }

  /** Record a requirement verified as already satisfied (see confirm_unchanged). */
  noteVerifiedNoop(noop: VerifiedNoop): void {
    this.verifiedNoops = [...this.verifiedNoops.filter((n) => n.requirement !== noop.requirement || n.path !== noop.path), noop]
  }

  /** A pure verified no-op: no mutation happened and at least one requirement was confirmed. */
  private alreadySatisfied(workspaceMutated: boolean): boolean {
    return !workspaceMutated && this.mutations === 0 && this.verifiedNoops.length > 0
  }

  invalidateVerification(): void {
    this.verification = 'not-run'
  }

  noteVerification(result: 'passed' | 'failed' | 'skipped'): void {
    this.verification = result
  }

  evaluateOutcome(input: {
    workspaceMutated: boolean
    codeMutated: boolean
    verifyPassed: boolean
    /** Files written this turn; checked against the request's named targets. */
    filesTouched?: string[]
  }): { ok: boolean; reason?: string; disposition?: OutcomeDisposition } {
    const result = this.evaluateOutcomeChecks(input)
    if (!result.ok) return result
    return {
      ok: true,
      disposition: input.workspaceMutated
        ? 'changed'
        : this.alreadySatisfied(input.workspaceMutated)
          ? 'already-satisfied'
          : 'none'
    }
  }

  private evaluateOutcomeChecks(input: {
    workspaceMutated: boolean
    codeMutated: boolean
    verifyPassed: boolean
    filesTouched?: string[]
  }): { ok: boolean; reason?: string } {
    const task = this.plan.task
    const noopPaths = this.alreadySatisfied(input.workspaceMutated)
      ? this.verifiedNoops.map((noop) => noop.path)
      : []
    if (this.plan.mode !== 'ask' && task?.requested?.artifact === 'patch' && !task.authority.edit)
      return { ok: false, reason: 'The requested workspace changes are blocked by this task’s mode, reference resolution or tool permissions.' }
    if (task?.authority.edit && task.requested?.targetFiles.length) {
      const problem = requestedFilesProblem(task, [...this.mutatedFiles, ...(input.filesTouched ?? []), ...noopPaths])
      if (problem) return { ok: false, reason: problem }
      if (requiresRequestedCodeVerification(task) && !input.verifyPassed && this.verification !== 'passed')
        return { ok: false, reason: 'Required code artifacts need a successful independent project check. Existing files and skipped verification do not establish implementation correctness.' }
    }
    if (
      this.contract.requiresWorkspaceEvidence &&
      this.successfulToolCalls === 0 &&
      !(['run', 'verify'].includes(this.contract.intent) && this.commandObservations > 0)
    ) {
      return { ok: false, reason: 'The agent produced no successful workspace evidence.' }
    }
    if (
      (this.contract.requiresSourceRead || ['review', 'plan'].includes(this.contract.intent)) &&
      this.contract.requiresWorkspaceEvidence &&
      !this.sourceReads
    ) {
      return {
        ok: false,
        reason: 'No project source was inspected. A directory listing does not ground this task.'
      }
    }
    if (this.contract.requiresMutation && !input.workspaceMutated) {
      const uncovered = this.contract.targetFiles.filter(
        (target) => !noopPaths.some((path) => sameFile(path, target))
      )
      if (!noopPaths.length)
        return { ok: false, reason: 'This edit request did not change the workspace.' }
      if (uncovered.length)
        return {
          ok: false,
          reason: `No change was made and ${uncovered.join(', ')} was not confirmed as already satisfying the request.`
        }
    }
    if ((this.contract.requiresSourceRead || ['review','plan'].includes(this.contract.intent)) &&
        (this.contract.requiresWorkspaceEvidence || (this.toolCalls>0 && task?.scope.applicability==='unverified')) && this.sourceEvidence) {
      const coverage=this.sourceEvidence.assess()
      if (!coverage.ok) return coverage
    }
    if (
      this.contract.requiresMutation &&
      !task?.requested?.targetFiles.length &&
      this.contract.targetFiles.length &&
      input.filesTouched &&
      ![...input.filesTouched, ...noopPaths].some((changed) =>
        this.contract.targetFiles.some((target) => sameFile(changed, target))
      )
    ) {
      return {
        ok: false,
        reason: `The request names ${this.contract.targetFiles.join(', ')}, but none of them changed. Edits to other files do not satisfy it.`
      }
    }
    if (
      this.contract.requiresVerificationAfterMutation &&
      input.codeMutated &&
      !input.verifyPassed &&
      this.verification !== 'skipped'
    ) {
      return { ok: false, reason: 'The code changed but no verification completed successfully.' }
    }
    return { ok: true }
  }

  complete(): void {
    if (this.phase !== 'completed') this.transition('completed')
  }

  block(reason: string): void {
    this.blockedReason = reason
    if (this.phase !== 'blocked') this.transition('blocked')
  }

  snapshot(): AgentWorkflowSnapshot {
    return {
      phase: this.phase,
      contract: this.contract,
      toolCalls: this.toolCalls,
      successfulToolCalls: this.successfulToolCalls,
      mutations: this.mutations,
      verification: this.verification,
      blockedReason: this.blockedReason,
      sourceEvidence: this.sourceEvidence?.snapshot(),
      ...(this.verifiedNoops.length ? { verifiedNoops: [...this.verifiedNoops] } : {})
    }
  }
}
