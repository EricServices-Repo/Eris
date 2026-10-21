import type { ChatIntent, TurnPlan } from '../../../../src/shared/settings-schema'
import { asksToImplementChanges } from '../../../../src/shared/agent-contract'

export type AgentWorkflowPhase =
  'planned' | 'answering' | 'preflight' | 'executing' | 'verifying' | 'completed' | 'blocked'

export type AgentOutcomeContract = {
  intent: ChatIntent
  requiresWorkspaceEvidence: boolean
  requiresMutation: boolean
  requiresVerificationAfterMutation: boolean
}

export type AgentWorkflowSnapshot = {
  phase: AgentWorkflowPhase
  contract: AgentOutcomeContract
  toolCalls: number
  successfulToolCalls: number
  mutations: number
  verification: 'not-run' | 'passed' | 'failed' | 'skipped'
  blockedReason?: string
}

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
  return {
    intent: plan.intent,
    requiresWorkspaceEvidence:
      requiresMutation || (plan.requiresTools && !['answer', 'capability'].includes(plan.intent)),
    requiresMutation,
    requiresVerificationAfterMutation: requiresMutation
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
  private verification: AgentWorkflowSnapshot['verification'] = 'not-run'
  private blockedReason: string | undefined

  readonly contract: AgentOutcomeContract

  constructor(plan: TurnPlan, goal = '') {
    this.contract = outcomeContractFor(plan, goal)
  }

  transition(next: AgentWorkflowPhase): void {
    if (next === this.phase) return
    if (!TRANSITIONS[this.phase].has(next)) {
      throw new Error(`Invalid agent workflow transition: ${this.phase} → ${next}`)
    }
    this.phase = next
  }

  noteTool(result: { ok: boolean; mutated: boolean; name?: string; path?: string }): void {
    this.toolCalls += 1
    if (result.name === 'run') this.commandObservations += 1
    if (result.ok) this.successfulToolCalls += 1
    if (
      result.ok &&
      ['read_file', 'notebook_read'].includes(result.name ?? '') &&
      result.path &&
      !result.path.startsWith('.eris/')
    )
      this.sourceReads += 1
    if (result.ok && result.mutated) this.mutations += 1
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
  }): { ok: boolean; reason?: string } {
    if (
      this.contract.requiresWorkspaceEvidence &&
      this.successfulToolCalls === 0 &&
      !(['run', 'verify'].includes(this.contract.intent) && this.commandObservations > 0)
    ) {
      return { ok: false, reason: 'The agent produced no successful workspace evidence.' }
    }
    if (
      ['review', 'plan'].includes(this.contract.intent) &&
      this.contract.requiresWorkspaceEvidence &&
      !this.sourceReads
    ) {
      return {
        ok: false,
        reason: 'No project source was inspected. A directory listing does not ground this task.'
      }
    }
    if (this.contract.requiresMutation && !input.workspaceMutated) {
      return { ok: false, reason: 'This edit request did not change the workspace.' }
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
      blockedReason: this.blockedReason
    }
  }
}
