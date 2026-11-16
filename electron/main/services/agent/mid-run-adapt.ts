import { chooseExecutionModel, executionLocal, workspaceLocalityViolation } from '../auto-model-policy'
import { resolveConnectionForModel } from '../model-catalog'
import { prohibitsModelRecovery } from './model-transition'
import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { findAgent, getProjectAgents, listResolvedAgents } from '../agents'

export type MidRunAdaptKind = 'escalate' | 'reroute' | null

export interface MidRunAdaptDecision {
  kind: MidRunAdaptKind
  reason: string
  nextToolsModel?: string
  nextPlan?: TurnPlan
  /** Why an available re-route was refused. */
  refused?: 'would-drop-edit-authority'
}

/** Escalations and re-routes allowed per turn. */
export const MID_RUN_ADAPT_BUDGET = 2

export function shouldConsiderMidRunAdapt(options: {
  verifyFailures: number
  consecutiveToolErrors: number
  noProgressStreak: number
  escalateCount: number
  rerouteCount: number
  goalRejectCount?: number
  workspaceMutated?: boolean
}): boolean {
  // Rejected completion after a write is not, on its own, evidence that a
  // different model will repair it. Actual tool/verification failures still count.
  if (options.workspaceMutated && options.goalRejectCount &&
      options.consecutiveToolErrors < 3 && options.verifyFailures < 2) return false
  if (options.escalateCount + options.rerouteCount >= MID_RUN_ADAPT_BUDGET) return false
  return (
    options.verifyFailures >= 2 ||
    options.consecutiveToolErrors >= 3 ||
    options.noProgressStreak >= 4
  )
}

/** Prefer Lite→Full escalate; otherwise re-route agent (specialist→orchestrator or reverse). */
export async function decideMidRunAdapt(options: {
  workspacePath: string
  settings: AppSettings
  plan: TurnPlan
  selectedModel: string
  goal: string
  getSecret: (key: string) => string | null
  signal?: AbortSignal
  escalateCount: number
  rerouteCount: number
  attemptedModels?: readonly string[]
  startingModel?: string
  failureText?: string
  actionLog: string[]
  filesTouched: string[]
}): Promise<MidRunAdaptDecision> {
  if (options.escalateCount + options.rerouteCount >= MID_RUN_ADAPT_BUDGET)
    return { kind: null, reason: 'Recovery transition budget exhausted' }
  const policy = options.plan.modelExecution?.policy
  if (
    policy &&
    policy !== 'fixed' &&
    !prohibitsModelRecovery(options.failureText || options.actionLog.slice(-3).join(' '))
  ) {
    const excluded = [...new Set([options.selectedModel, ...(options.attemptedModels || [])])]
    const choice = await chooseExecutionModel(
      options.settings,
      options.plan.intent,
      policy,
      excluded
    )
    const start = options.startingModel ?? options.selectedModel
    const origin = resolveConnectionForModel(options.settings, start)
    const hasLocalState = [start, options.selectedModel, ...(options.attemptedModels ?? [])]
      .some(model => executionLocal(options.settings, model))
    const canUseRemote = policy === 'auto-any' && !hasLocalState && origin?.type === 'openai-compatible'
    const candidates = choice.candidates.filter(candidate => {
      if (!candidate.eligible || workspaceLocalityViolation(options.settings, candidate.model)) return false
      if (executionLocal(options.settings, candidate.model)) return true
      if (!canUseRemote) return false
      const target = resolveConnectionForModel(options.settings, candidate.model)
      return target?.type === 'openai-compatible' && (
        target.id === origin.id || options.settings.agent.recoveryAcrossProviders === true
      )
    })
    const fallbacks = options.settings.models.fallbacks ?? []
    const explicit = fallbacks.map(model => candidates.find(candidate => candidate.model === model)).find(Boolean)
    const tierRank = { small: 0, standard: 1, strong: 2, frontier: 3 }
    const tier = (model: string) => {
      const profile = options.settings.models.capabilityProfiles?.[model]
      return profile ? tierRank[profile.tier] : -1
    }
    const alternate = explicit ?? candidates.sort((a, b) =>
      tier(b.model) - tier(a.model) ||
      Number(b.model === choice.model) - Number(a.model === choice.model) ||
      b.rank - a.rank
    )[0]
    if (alternate)
      return {
        kind: 'reroute',
        reason: `Model recovery: ${options.selectedModel} → ${alternate.model} · ${explicit ? 'configured fallback' : 'eligible recovery model'}`,
        nextPlan: {
          ...options.plan,
          method: 'handoff',
          models: {
            ...options.plan.models,
            chat: alternate.model,
            tools: alternate.model,
            primary: options.plan.models.primary === options.selectedModel ? alternate.model : options.plan.models.primary,
            fast: options.plan.models.fast === options.selectedModel ? alternate.model : options.plan.models.fast
          },
          modelExecution: {
            ...options.plan.modelExecution!,
            candidates: choice.candidates,
            basis: 'recovery'
          }
        }
      }
    return {
      kind: null,
      reason: `No untried model eligible under the recovery policy. ${choice.candidates.map((c) => `${c.model}: ${c.reason}`).join('; ')}`
    }
  }
  if (prohibitsModelRecovery(options.failureText || ''))
    return { kind: null, reason: 'Safety or permission refusal: no model recovery' }
  if (options.rerouteCount >= 1) return { kind: null, reason: '' }

  const resolved = listResolvedAgents(options.workspacePath, options.settings)
  const current = resolved.find((a) => a.id === options.plan.agentId)
  const orchestrator =
    resolved.find((a) => a.role === 'orchestrator') ||
    findAgent(options.workspacePath, options.settings.agent.routing.fallbackAgentId) ||
    getProjectAgents(options.workspacePath).orchestrator

  let targetId: string | null = null
  if (current?.role === 'specialist' && orchestrator && orchestrator.id !== current.id) {
    targetId = orchestrator.id
  } else if (current?.role === 'orchestrator' || options.plan.agentId === 'composer') {
    const coder = findAgent(options.workspacePath, 'coder')
    if (coder?.enabled) targetId = coder.id
  }

  if (!targetId) {
    return { kind: null, reason: '' }
  }

  const target = findAgent(options.workspacePath, targetId)
  if (!target?.enabled) return { kind: null, reason: '' }
  const ranks = ['none', 'read', 'edit', 'full'] as const
  const ceiling = target.tools ?? 'read'
  const toolPolicy =
    ranks[Math.min(ranks.indexOf(options.plan.toolPolicy), ranks.indexOf(ceiling))]!
  // Recovery may change strategy, never the task: a change request cannot become
  // a read-only review because the replacement worker cannot edit.
  if (options.plan.task?.authority.edit && ranks.indexOf(toolPolicy) < ranks.indexOf('edit'))
    return { kind: null, reason: '', refused: 'would-drop-edit-authority' }
  const nextPlan: TurnPlan = {
    ...options.plan,
    agentId: target.id,
    agentName: target.name,
    toolPolicy,
    method: 'handoff'
  }

  if (nextPlan.error) return { kind: null, reason: '' }

  return {
    kind: 'reroute',
    reason: `Mid-run re-route: ${options.plan.agentName} → ${nextPlan.agentName}`,
    nextPlan
  }
}
