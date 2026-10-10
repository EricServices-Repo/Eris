import type {
  AgentDefinition,
  AgentToolsCeiling,
  AppSettings,
  ChatIntent,
  ChatTurnContext,
  RouteResult,
  TurnPlan
} from '../../../src/shared/settings-schema'
import { allAgentsFlat, findAgent } from './agents'
import {
  isBuiltinRef,
  isExactBuiltinReady,
  resolveExactBuiltinRef
} from './builtin-model'
import { streamModelChat } from './chat-runtime'
import { routeHeuristic, routeMessage } from './router'

const CEILING_RANK: Record<AgentToolsCeiling, number> = {
  none: 0,
  read: 1,
  edit: 2,
  full: 3
}

const READ_TOOLS = new Set([
  'tree',
  'list_dir',
  'read_file',
  'grep',
  'glob',
  'search_symbols',
  'retrieve',
  'read_context',
  'read_email',
  'list_skills',
  'read_skill',
  'git_status',
  'git_diff'
])

const EDIT_TOOLS = new Set([
  ...READ_TOOLS,
  'search_replace',
  'apply_patch',
  'write_file',
  'mkdir',
  'delete_path',
  'rename_path',
  'update_context',
  'write_skill',
  'git_stage',
  'git_commit',
  'git_stash'
])

const FULL_TOOLS = new Set([...EDIT_TOOLS, 'run', 'git_sync'])

export function intentNeedsTools(intent: ChatIntent): boolean {
  return intent === 'explore' || intent === 'edit' || intent === 'review' || intent === 'run'
}

export function intentNeedsMutation(intent: ChatIntent): boolean {
  return intent === 'edit' || intent === 'run'
}

/** Questions about Eris AI models/providers — not workspace files named “models”. */
export function isErisCapabilityQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (
    /\b(what|which|list|show|name)\b[\s\S]{0,48}\b(ai\s+)?models?\b/i.test(t) ||
    /\b(ai\s+)?models?\b[\s\S]{0,48}\b(access|available|have|installed|connected|ready|using|use)\b/i.test(
      t
    )
  ) {
    return true
  }
  if (
    /\b(ollama|composer\s*(lite|full)?|openai|anthropic)\b[\s\S]{0,32}\b(model|models|connected|ready)\b/i.test(
      t
    )
  ) {
    return true
  }
  return false
}

export function classifyIntent(text: string, mode: 'ask' | 'agent'): ChatIntent {
  if (isErisCapabilityQuestion(text)) return 'capability'
  if (mode === 'ask') return 'answer'

  const t = text.trim()
  if (!t) return 'answer'

  if (
    /\b(code review|pull request|pr review|security review|risk assessment)\b/i.test(t) ||
    (/\breview\b/i.test(t) && /\b(pr|diff|patch|commit|regression|smell)\b/i.test(t))
  ) {
    return 'review'
  }

  if (
    /\b(npm (test|run|start|install)|yarn |pnpm |bun |pytest|cargo test|make |docker )\b/i.test(
      t
    ) ||
    /\b(run|execute|start)\b[\s\S]{0,24}\b(test|tests|build|server|dev)\b/i.test(t)
  ) {
    return 'run'
  }

  if (
    /\b(create|implement|refactor|scaffold|generate|delete|mkdir|rename|patch|write_file|search_replace)\b/i.test(
      t
    ) ||
    /\b(fix|build|add|update|edit)\b[\s\S]{0,40}\b(file|files|code|bug|feature|function|component|test)\b/i.test(
      t
    ) ||
    /\b(make sure|ensure)\b[\s\S]{0,40}\b(work|working|builds?|passes?)\b/i.test(t) ||
    /\b(write|add)\b[\s\S]{0,20}\b(skill|skills)\b/i.test(t)
  ) {
    return 'edit'
  }

  if (
    /\b(where is|find|locate|search|grep|look (at|for)|show me|open)\b/i.test(t) ||
    /\b(explore|inspect|list files|tree)\b/i.test(t) ||
    /\bwhat (files?|does|is in)\b/i.test(t)
  ) {
    return 'explore'
  }

  if (/\b(explain|how does|what does|overview|summarize|why)\b/i.test(t)) {
    return 'answer'
  }

  return 'answer'
}

function intentToolFloor(intent: ChatIntent): AgentToolsCeiling {
  switch (intent) {
    case 'answer':
    case 'capability':
      return 'none'
    case 'explore':
    case 'review':
      return 'read'
    case 'edit':
      return 'edit'
    case 'run':
      return 'full'
    default:
      return 'none'
  }
}

export function minCeiling(a: AgentToolsCeiling, b: AgentToolsCeiling): AgentToolsCeiling {
  return CEILING_RANK[a] <= CEILING_RANK[b] ? a : b
}

/** Effective policy = min(agent ceiling, intent floor); Ask/answer/capability → none. */
export function effectiveToolPolicy(
  agent: AgentDefinition,
  intent: ChatIntent,
  mode: 'ask' | 'agent'
): AgentToolsCeiling {
  if (mode === 'ask' || intent === 'answer' || intent === 'capability') return 'none'
  const floor = intentToolFloor(intent)
  const ceiling = agent.tools ?? 'edit'
  return minCeiling(ceiling, floor)
}

export function toolAllowedByPolicy(toolName: string, policy: AgentToolsCeiling): boolean {
  if (policy === 'none') return false
  if (toolName.startsWith('mcp__')) return policy === 'full' || policy === 'edit'
  if (policy === 'read') return READ_TOOLS.has(toolName)
  if (policy === 'edit') return EDIT_TOOLS.has(toolName)
  return FULL_TOOLS.has(toolName) || toolName.startsWith('mcp__')
}

export function filterToolsByPolicy<T extends { function: { name: string } }>(
  tools: T[],
  policy: AgentToolsCeiling
): T[] {
  if (policy === 'none') return []
  return tools.filter((t) => toolAllowedByPolicy(t.function.name, policy))
}

export function resolveModelRoles(options: {
  selectedModel: string
  intent: ChatIntent
  toolPolicy: AgentToolsCeiling
  preferEscalate: boolean
}): { chat: string; tools: string; escalateToFull: boolean; error?: string } {
  const selected = options.selectedModel.trim() || 'builtin:composer-lite'
  const needsTools = options.toolPolicy !== 'none' && intentNeedsTools(options.intent)

  if (!isBuiltinRef(selected)) {
    return { chat: selected, tools: selected, escalateToFull: false }
  }

  const exact = resolveExactBuiltinRef(selected)
  if (!exact) {
    return {
      chat: selected,
      tools: selected,
      escalateToFull: false,
      error: `Model “${selected}” is not ready. Download it in Settings → Models.`
    }
  }

  const isLite = exact === 'builtin:composer-lite' || /lite/i.test(exact)
  const fullReady = isExactBuiltinReady('builtin:composer')

  if (!needsTools || !options.preferEscalate || !isLite) {
    return { chat: exact, tools: exact, escalateToFull: false }
  }

  if (fullReady) {
    return {
      chat: exact,
      tools: 'builtin:composer',
      escalateToFull: true
    }
  }

  return {
    chat: exact,
    tools: exact,
    escalateToFull: false
  }
}

function formatReason(parts: {
  method: TurnPlan['method']
  agentName: string
  intent: ChatIntent
  chat: string
  tools: string
  escalateToFull: boolean
}): string {
  const chatShort = parts.chat.replace(/^builtin:/, '')
  const toolsShort = parts.tools.replace(/^builtin:/, '')
  const modelBit =
    parts.escalateToFull || parts.chat !== parts.tools
      ? `${chatShort} → tools:${toolsShort}`
      : chatShort
  return `${parts.method === 'manual' ? 'Manual' : parts.method === 'llm' ? 'LLM' : 'Auto'} → ${parts.agentName} · ${parts.intent} · ${modelBit}`
}

async function llmRouteHint(options: {
  settings: AppSettings
  text: string
  agents: AgentDefinition[]
  getSecret: (key: string) => string | null
  signal?: AbortSignal
}): Promise<{ intent?: ChatIntent; agentId?: string } | null> {
  const routerModel =
    options.settings.agent.routing.routerModel ||
    options.settings.models.defaultModel ||
    'builtin:composer-lite'
  if (isBuiltinRef(routerModel) && !isExactBuiltinReady(routerModel)) {
    // Fall back: any ready lite, else skip LLM router
    if (!isExactBuiltinReady('builtin:composer-lite')) return null
  }
  const model = isBuiltinRef(routerModel)
    ? resolveExactBuiltinRef(routerModel) ||
      resolveExactBuiltinRef('builtin:composer-lite') ||
      routerModel
    : routerModel

  const agentIds = options.agents.map((a) => a.id).join(', ')
  const prompt =
    `Classify this IDE chat message. Reply with ONLY JSON: ` +
    `{"intent":"answer|capability|explore|edit|review|run","agentId":"<id>","confidence":0-1}\n` +
    `Valid agentIds: ${agentIds}\n` +
    `Message:\n${options.text.slice(0, 1200)}`

  try {
    let out = ''
    for await (const chunk of streamModelChat({
      settings: options.settings,
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a router. Output compact JSON only. No markdown.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      signal: options.signal,
      getSecret: options.getSecret
    })) {
      out += chunk
    }
    const match = out.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as {
      intent?: string
      agentId?: string
    }
    const intents: ChatIntent[] = [
      'answer',
      'capability',
      'explore',
      'edit',
      'review',
      'run'
    ]
    const intent = intents.includes(parsed.intent as ChatIntent)
      ? (parsed.intent as ChatIntent)
      : undefined
    const agentId =
      parsed.agentId && options.agents.some((a) => a.id === parsed.agentId)
        ? parsed.agentId
        : undefined
    return { intent, agentId }
  } catch {
    return null
  }
}

export async function planChatTurn(options: {
  workspacePath: string | null
  settings: AppSettings
  context: ChatTurnContext
  getSecret: (key: string) => string | null
  signal?: AbortSignal
}): Promise<TurnPlan> {
  const mode = options.context.mode === 'ask' ? 'ask' : 'agent'
  const text = options.context.text || ''
  const selectedModel =
    options.context.selectedModel.trim() ||
    options.settings.models.defaultModel ||
    'builtin:composer-lite'

  let heuristicIntent = classifyIntent(text, mode)

  const route: RouteResult = await routeMessage({
    workspacePath: options.workspacePath,
    settings: options.settings,
    text,
    fileNames: options.context.fileNames || [],
    manualAgentId: options.context.manualAgentId
  })

  let agent =
    findAgent(options.workspacePath, route.agentId) ||
    allAgentsFlat(options.workspacePath)[0]

  let method = route.method
  let intent = heuristicIntent

  if (
    mode === 'agent' &&
    options.settings.agent.routing.enabled &&
    options.settings.agent.routing.useLlmRouter &&
    !options.context.manualAgentId
  ) {
    const agents = allAgentsFlat(options.workspacePath).filter((a) => a.enabled)
    const hint = await llmRouteHint({
      settings: options.settings,
      text,
      agents,
      getSecret: options.getSecret,
      signal: options.signal
    })
    if (hint?.intent) intent = hint.intent
    if (hint?.agentId) {
      const picked = findAgent(options.workspacePath, hint.agentId)
      if (picked?.enabled) {
        agent = picked
        method = 'llm'
      }
    } else if (hint) {
      method = 'llm'
    }
  }

  // Capability always wins over LLM misclassifies
  if (isErisCapabilityQuestion(text)) intent = 'capability'
  if (mode === 'ask' && intent !== 'capability') intent = 'answer'

  if (!agent) {
    return {
      intent,
      agentId: 'composer',
      agentName: 'Composer',
      mode,
      models: { chat: selectedModel, tools: selectedModel },
      toolPolicy: 'none',
      requiresTools: false,
      escalateToFull: false,
      reason: 'No agents configured',
      method: 'default',
      error: 'No agents configured'
    }
  }

  const toolPolicy = effectiveToolPolicy(agent, intent, mode)
  const roles = resolveModelRoles({
    selectedModel,
    intent,
    toolPolicy,
    preferEscalate: agent.preferEscalate !== false
  })

  const requiresTools = toolPolicy !== 'none' && intentNeedsTools(intent)

  return {
    intent,
    agentId: agent.id,
    agentName: agent.name,
    mode,
    models: {
      chat: roles.chat,
      tools: roles.tools,
      router: options.settings.agent.routing.useLlmRouter
        ? options.settings.agent.routing.routerModel
        : undefined
    },
    toolPolicy,
    requiresTools,
    escalateToFull: roles.escalateToFull,
    reason: formatReason({
      method,
      agentName: agent.name,
      intent,
      chat: roles.chat,
      tools: roles.tools,
      escalateToFull: roles.escalateToFull
    }),
    method,
    error: roles.error
  }
}

/** Legacy RouteResult from a TurnPlan (status bar / older callers). */
export function turnPlanToRouteResult(plan: TurnPlan): RouteResult {
  return {
    agentId: plan.agentId,
    agentName: plan.agentName,
    model: plan.models.chat,
    reason: plan.reason,
    method: plan.method
  }
}

// Re-export heuristic agent scoring for tests / thin router
export { routeHeuristic }
