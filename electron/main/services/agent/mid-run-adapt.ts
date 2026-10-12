import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { findAgent, getProjectAgents, listResolvedAgents } from '../agents'
import { planChatTurn } from '../chat-router'

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

  const contextBlob = [
    options.goal,
    '',
    'Prior progress:',
    ...options.actionLog.slice(-12).map((l) => `- ${l}`),
    options.filesTouched.length
      ? `Files touched: ${[...new Set(options.filesTouched)].join(', ')}`
      : '',
    `Re-route from ${options.plan.agentId} → ${targetId} after stuck signals.`
  ]
    .filter(Boolean)
    .join('\n')

  const nextPlan = await planChatTurn({
    workspacePath: options.workspacePath,
    settings: options.settings,
    context: {
      text: contextBlob,
      selectedModel: options.selectedModel,
      mode: 'agent',
      manualAgentId: targetId,
      forceRoute: 'tools'
    },
    getSecret: options.getSecret,
    signal: options.signal
  })

  if (nextPlan.error) return { kind: null, reason: '' }

  return {
    kind: 'reroute',
    reason: `Mid-run re-route: ${options.plan.agentName} → ${nextPlan.agentName}`,
    nextPlan
  }
}
