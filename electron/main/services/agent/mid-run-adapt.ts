import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { findAgent, getProjectAgents, listResolvedAgents } from '../agents'

export type MidRunAdaptKind = 'escalate' | 'reroute' | null

export interface MidRunAdaptDecision {
  kind: MidRunAdaptKind
  reason: string
  nextToolsModel?: string
  nextPlan?: TurnPlan
}

export function shouldConsiderMidRunAdapt(options: {
  verifyFailures: number
  consecutiveToolErrors: number
  noProgressStreak: number
  escalateCount: number
  rerouteCount: number
}): boolean {
  if (options.escalateCount + options.rerouteCount >= 2) return false
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
  actionLog: string[]
  filesTouched: string[]
}): Promise<MidRunAdaptDecision> {
  // Composer Full is Cloud Agents only — never mid-run escalate to local Full.
  if (options.rerouteCount >= 1) {
    return { kind: null, reason: '' }
  }

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
