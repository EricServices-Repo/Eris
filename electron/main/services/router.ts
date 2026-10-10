import type { AppSettings, RouteResult, AgentDefinition } from '../../../src/shared/settings-schema'
import { allAgentsFlat, findAgent } from './agents'

function resolveModel(agent: AgentDefinition, settings: AppSettings): string {
  return agent.model.trim() || settings.models.defaultModel
}

function scoreHeuristic(agent: AgentDefinition, text: string, fileNames: string[]): number {
  const hay = `${text}\n${fileNames.join('\n')}`.toLowerCase()
  const wantsBuild =
    /\b(build|implement|add|create|fix|refactor|code|feature|write|generate|scaffold|project|app|working|make sure|ensure)\b/i.test(
      text
    )
  const wantsCodeReview =
    /\b(code review|review (this )?pr|pull request|security review|risk assessment)\b/i.test(text) ||
    (/\breview\b/i.test(text) && /\b(pr|diff|patch|commit|regression)\b/i.test(text))

  let score = 0
  for (const keyword of agent.keywords) {
    const k = keyword.toLowerCase().trim()
    if (!k) continue
    if (hay.includes(k)) score += k.includes(' ') ? 3 : 2
  }
  if (agent.id === 'composer') {
    // Prefer Composer for project/build/ensure-working asks
    if (wantsBuild) score += 5
    if (/\b(folder|workspace|calculator|todo|app)\b/i.test(text)) score += 2
  }
  if (agent.id === 'coder') {
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|swift|css|html)\b/i.test(hay)) score += 2
    if (/```/.test(text)) score += 2
    if (wantsBuild) score += 2
  }
  if (agent.id === 'explainer' && /\b(explain|overview|summarize|what does)\b/i.test(text)) {
    score += 3
  }
  if (agent.id === 'reviewer') {
    // Only boost Reviewer for real code-review asks — not "review the folder and make an app"
    if (wantsCodeReview) score += 5
    else if (/\breview\b/i.test(text) && !wantsBuild) score += 2
    if (wantsBuild && !wantsCodeReview) score -= 6
  }
  if (agent.id === 'fast' && text.trim().length < 80) score += 1
  return score
}

function fallbackAgent(workspacePath: string | null, settings: AppSettings): AgentDefinition {
  const id = settings.agent.routing.fallbackAgentId || 'composer'
  return (
    findAgent(workspacePath, id) ||
    findAgent(workspacePath, 'composer') ||
    findAgent(workspacePath, 'orchestrator') ||
    allAgentsFlat(workspacePath)[0]
  )
}

export function routeHeuristic(
  workspacePath: string | null,
  settings: AppSettings,
  text: string,
  fileNames: string[]
): RouteResult {
  const agents = allAgentsFlat(workspacePath).filter((a) => a.enabled)
  if (agents.length === 0) {
    return {
      agentId: 'composer',
      agentName: 'Composer',
      model: settings.models.defaultModel || 'builtin:composer-lite',
      reason: 'No agents configured',
      method: 'default'
    }
  }

  let best = agents[0]
  let bestScore = -1
  for (const agent of agents) {
    const score = scoreHeuristic(agent, text, fileNames)
    if (score > bestScore) {
      best = agent
      bestScore = score
    }
  }

  if (bestScore <= 0) {
    const general = fallbackAgent(workspacePath, settings)
    return {
      agentId: general.id,
      agentName: general.name,
      model: resolveModel(general, settings),
      reason: 'No strong keyword match; using fallback',
      method: 'heuristic'
    }
  }

  return {
    agentId: best.id,
    agentName: best.name,
    model: resolveModel(best, settings),
    reason: `Matched keywords (score ${bestScore})`,
    method: 'heuristic'
  }
}

export async function routeWithLlm(
  workspacePath: string | null,
  settings: AppSettings,
  text: string,
  fileNames: string[]
): Promise<RouteResult> {
  // LLM routing can use connections later; keyword routing is the local default.
  const fallback = routeHeuristic(workspacePath, settings, text, fileNames)
  return {
    ...fallback,
    reason: `${fallback.reason} (LLM router uses heuristic with built-in Composer)`
  }
}

export async function routeMessage(options: {
  workspacePath: string | null
  settings: AppSettings
  text: string
  fileNames: string[]
  manualAgentId?: string | null
}): Promise<RouteResult> {
  const { workspacePath, settings, text, fileNames, manualAgentId } = options
  const routing = settings.agent.routing

  if (!routing.enabled || routing.mode === 'off') {
    const general = fallbackAgent(workspacePath, settings)
    return {
      agentId: general.id,
      agentName: general.name,
      model: resolveModel(general, settings),
      reason: 'Routing disabled',
      method: 'default'
    }
  }

  if (manualAgentId) {
    const agent = findAgent(workspacePath, manualAgentId)
    if (agent && agent.enabled) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        model: resolveModel(agent, settings),
        reason: 'User selected agent',
        method: 'manual'
      }
    }
  }

  if (routing.mode === 'manual') {
    const general = fallbackAgent(workspacePath, settings)
    return {
      agentId: general.id,
      agentName: general.name,
      model: resolveModel(general, settings),
      reason: 'Manual mode without selection; using fallback',
      method: 'manual'
    }
  }

  if (routing.useLlmRouter) {
    return routeWithLlm(workspacePath, settings, text, fileNames)
  }
  return routeHeuristic(workspacePath, settings, text, fileNames)
}
