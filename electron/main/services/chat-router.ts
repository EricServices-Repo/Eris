import { asksForImageGeneration } from '../../../src/shared/image-generation'
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
import { isBuiltinRef, isExactBuiltinReady, resolveExactBuiltinRef } from './builtin-model'
import { getLocalStatuses, isLocalRef, resolveExactLocalRef } from './local-model'
import { streamModelChat } from './chat-runtime'
import { getToolContract, type ToolAccess } from './tool-registry'
import { routeHeuristic, routeMessage } from './router'
import { learnedRouteFor, readRoutingCorrections, routingExamples } from './routing-feedback'
import {
  agentForFollowUp,
  asksForRecommendations,
  asksForPlan,
  asksForVerification,
  asksToImplementChanges,
  asksWhatTheProjectDoes,
  asksWorkspaceQuestion,
  isConversationFollowUp,
  needsWebLookup,
  chatAgentForTurn
} from '../../../src/shared/agent-contract'
import { CONTEXT_HEADROOM_BYTES, inferenceBudgetBytes } from './vram-fit'

/** A custom agent must be at least this sure to replace the roster role. */
const CUSTOM_AGENT_MIN_CONFIDENCE = 0.75

/** LLM router hints below this confidence are ignored. */
const LLM_MIN_CONFIDENCE = 0.55

const CEILING_RANK: Record<AgentToolsCeiling, number> = {
  none: 0,
  read: 1,
  edit: 2,
  full: 3
}

const TOOL_ACCESS_RANK: Record<ToolAccess, number> = { read: 1, edit: 2, full: 3 }
const POLICY_ACCESS_RANK: Record<AgentToolsCeiling, number> = {
  none: 0,
  read: 1,
  edit: 2,
  full: 3
}

const NON_CHAT_LOCAL = /mmproj|embed|clip|vision|encoder/i

/**
 * Largest ready local chat GGUF whose weights plus context headroom fit the budget.
 * Unknown or too-small budgets stay on Composer Lite.
 */
export function bestFittingLocalModel(
  models: Array<{
    ref: string
    ready?: boolean
    approxBytes?: number
    filename?: string
    name?: string
  }>,
  budgetBytes: number
): string | null {
  if (budgetBytes <= 0) return null
  const fitting = models
    .filter((m) => {
      if (m.ready === false || !isLocalRef(m.ref)) return false
      const bytes = m.approxBytes || 0
      if (bytes <= 0) return false
      if (NON_CHAT_LOCAL.test(`${m.filename || ''} ${m.name || ''} ${m.ref}`)) return false
      return bytes + CONTEXT_HEADROOM_BYTES <= budgetBytes
    })
    .sort((a, b) => (b.approxBytes || 0) - (a.approxBytes || 0))
  return fitting[0]?.ref ?? null
}

export async function readyLocalHandoffRef(settings: AppSettings): Promise<string | null> {
  let budget = 0
  try {
    const { getGpuAccelStatus } = await import('./gpu-accel')
    const gpu = await getGpuAccelStatus(settings.models.preferEgpu !== false)
    budget = inferenceBudgetBytes({
      vramShareFreeBytes: gpu.vramShareFreeBytes,
      vramShareTotalBytes: gpu.vramShareTotalBytes,
      preferredFreeBytes: gpu.preferredGpu?.vramFreeBytes,
      preferredTotalBytes: gpu.preferredGpu?.vramBytes
    })
  } catch {
    budget = 0
  }
  return bestFittingLocalModel(getLocalStatuses(), budget)
}

export function localComposerFullActive(settings: AppSettings): boolean {
  return (
    settings.agent.routing.useLocalComposerFull === true && isExactBuiltinReady('builtin:composer')
  )
}

export function selectComposerLocalHandoff(options: {
  selectedModel: string
  intent: ChatIntent
  profile?: 'auto' | 'local' | 'max'
  preferCloudComposer: boolean
  cloudJobsExhausted: boolean
  readyLocalRef: string | null
}): { ref: string; because: 'usage' | 'local' } | null {
  if (!options.readyLocalRef) return null
  if (!intentNeedsMutation(options.intent)) return null
  const selected = options.selectedModel.trim() || 'builtin:composer-lite'
  if (!isBuiltinRef(selected) || !/composer/i.test(selected)) return null
  const profile = options.profile ?? 'auto'
  if (profile === 'local' || options.preferCloudComposer === false) {
    return { ref: options.readyLocalRef, because: 'local' }
  }
  if (options.cloudJobsExhausted) {
    return { ref: options.readyLocalRef, because: 'usage' }
  }
  return null
}

export function intentNeedsTools(intent: ChatIntent): boolean {
  return (
    intent === 'explore' ||
    intent === 'plan' ||
    intent === 'edit' ||
    intent === 'review' ||
    intent === 'verify' ||
    intent === 'run'
  )
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

export function classifyIntent(
  text: string,
  mode: 'ask' | 'agent',
  fileNames: string[] = []
): ChatIntent {
  if (isErisCapabilityQuestion(text)) return 'capability'
  if (needsWebLookup(text)) return 'explore'
  if (
    mode === 'ask' &&
    !asksWorkspaceQuestion(text, fileNames) &&
    !asksForPlan(text) &&
    !asksForVerification(text)
  ) {
    return 'answer'
  }
  if (mode === 'ask') return classifyIntent(text, 'agent', fileNames)

  const t = text.trim()
  if (!t) return 'answer'

  if (
    /\b(npm (test|run|start|install)|yarn |pnpm |bun |pytest|cargo test|docker )\b/i.test(t) ||
    // Makefile targets only — not "make a new app/project"
    /\bmake\s+(test|check|build|all|install|clean|run|lint)\b/i.test(t) ||
    /\b(run|execute|start)\b[\s\S]{0,24}\b(test|tests|build|server|dev)\b/i.test(t) ||
    // "how do I launch/run/start this app?" → run/inspect, not a tool-less FAQ answer
    /\b(how (do|can|to)|where do)\b[\s\S]{0,40}\b(launch|run|start|open|build)\b[\s\S]{0,40}\b(app|application|\.app|project|xcode|scheme)\b/i.test(
      t
    ) ||
    /\b(launch|run|start|open)\b[\s\S]{0,24}\b(the\s+)?(app|application|\.app)\b/i.test(t)
  ) {
    return 'run'
  }

  if (asksForImageGeneration(t)) return 'edit'
  if (asksToImplementChanges(t)) return 'edit'
  // In Agent mode, natural implementation requests such as “show me how to add”
  // and “I need to implement … how would you approach it?” must reach Composer.
  // Routing them as explore/verify creates an impossible read-only loop because
  // the completion gate correctly expects the requested code mutation.
  if (
    /\b(?:show me how to|help me(?:\s+to)?|i need to|i(?:'m| am) trying to|how (?:do|can|would) (?:i|you))\b[\s\S]{0,64}\b(?:add|build|create|develop|generate|implement|introduce|write)\b/i.test(
      t
    )
  ) {
    return 'edit'
  }
  if (asksForPlan(t)) return 'plan'
  if (asksForVerification(t)) return 'verify'

  // “What does this project do?” is a description, even when the message says “review”.
  if (asksWhatTheProjectDoes(t)) return 'explore'

  // “What improvements should we make?” is a review list, not an edit.
  if (asksForRecommendations(t)) return 'review'

  // Improvements / polish count as edits even when the user also says "review".
  if (
    /\b(improv(e|es|ed|ing|ement|ements)|polish|enhance|enhancement|refactor|optimize|clean ?up)\b/i.test(
      t
    )
  ) {
    return 'edit'
  }

  if (
    /\b(create|implement|scaffold|generate|delete|mkdir|rename|patch|write_file|search_replace|develop)\b/i.test(
      t
    ) ||
    // "build/fix/add … file|code|app|project|…" — greenfield product asks count as edits
    /\b(fix|build|add|update|edit|make|write)\b[\s\S]{0,48}\b(file|files|code|bug|feature|function|component|test|failure|failures|error|errors|app|application|project|program|tool|cli|game|website|site|mac\s*os|macos|osx|ios|android|swift|electron|desktop|package|module|service|calculator)\b/i.test(
      t
    ) ||
    /\b(build|create|make|scaffold|generate)\s+(me\s+)?(a|an|the)\b/i.test(t) ||
    /\bnew\s+(app|application|project|package|module|component)\b/i.test(t) ||
    /\b(make sure|ensure)\b[\s\S]{0,40}\b(work|working|builds?|passes?)\b/i.test(t) ||
    // "Make it so it works" / "get it working"
    /\bmake\b[\s\S]{0,32}\b(it\s+)?(so\s+it\s+)?works?\b/i.test(t) ||
    /\b(get|make)\b[\s\S]{0,24}\b(it|this|the app)\b[\s\S]{0,24}\bwork/i.test(t) ||
    /\b(write|add)\b[\s\S]{0,20}\b(skill|skills)\b/i.test(t)
  ) {
    return 'edit'
  }

  if (
    /\b(code review|pull request|pr review|security review|risk assessment)\b/i.test(t) ||
    (/\breview\b/i.test(t) &&
      /\b(pr|diff|patch|commit|regression|smell|project|folder|codebase|workspace|repo|app|code)\b/i.test(
        t
      ))
  ) {
    return 'review'
  }

  if (
    /\b(where is|which file|what file|find|locate|grep|look (at|for)|show me|open)\b/i.test(t) ||
    /\bsearch\s+(?:for|in|the|this|my|our)\b/i.test(t) ||
    /\b(explore|inspect|list files|tree)\b/i.test(t) ||
    /\bwhat (files?|does|is in)\b/i.test(t)
  ) {
    return 'explore'
  }

  if (/\b(explain|how does|what does|overview|summarize|why)\b/i.test(t)) {
    // Agent mode must read the workspace. Ask mode stays a plain answer.
    return mode === 'agent' ? 'explore' : 'answer'
  }

  if (mode === 'agent' && needsWebLookup(t)) return 'explore'

  return 'answer'
}

function intentToolFloor(intent: ChatIntent): AgentToolsCeiling {
  switch (intent) {
    case 'answer':
    case 'capability':
      return 'none'
    case 'explore':
    case 'plan':
    case 'review':
    case 'verify':
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
  if (intent === 'answer' || intent === 'capability') return 'none'
  // Ask can inspect the workspace, but its ceiling never includes mutations.
  if (mode === 'ask') return intentNeedsTools(intent) ? 'read' : 'none'
  const floor = intentToolFloor(intent)
  let ceiling = agent.tools ?? 'edit'
  // Never let a "tools: none" specialist (e.g. Fast) strip workspace tools from
  // explore/edit/review/run — those intents require at least the intent floor.
  if (ceiling === 'none' && floor !== 'none') ceiling = floor
  return minCeiling(ceiling, floor)
}

export function toolAllowedByPolicy(
  toolName: string,
  policy: AgentToolsCeiling,
  mcpReadOnly = false
): boolean {
  if (policy === 'none') return false
  // An MCP read-only annotation is a visibility hint, not approval. Its runtime
  // effect still goes through the per-tool consent callback in the dispatcher.
  const requiredAccess: ToolAccess | undefined = toolName.startsWith('mcp__')
    ? mcpReadOnly
      ? 'read'
      : 'full'
    : getToolContract(toolName)?.access
  return Boolean(requiredAccess && POLICY_ACCESS_RANK[policy] >= TOOL_ACCESS_RANK[requiredAccess])
}

export function filterToolsByPolicy<T extends { function: { name: string } }>(
  tools: T[],
  policy: AgentToolsCeiling,
  mcpReadOnlyTools?: ReadonlySet<string>
): T[] {
  if (policy === 'none') return []
  return tools.filter((t) =>
    toolAllowedByPolicy(t.function.name, policy, mcpReadOnlyTools?.has(t.function.name) ?? false)
  )
}

/** Empty or "auto" lets the turn choose among ready models. Anything else is used as picked. */
export function isAutoModelChoice(selected: string): boolean {
  const name = selected.trim()
  return !name || name === 'auto'
}

/**
 * Auto picks a model for this turn. A heavy edit prefers Composer Full when Cloud
 * is allowed, otherwise Composer Lite, then a ready local or connected model.
 */
export async function pickAutoChatModel(
  settings: AppSettings,
  intent: ChatIntent
): Promise<string> {
  return (await chooseAutoChatModel(settings, intent)).model
}

async function chooseAutoChatModel(
  settings: AppSettings,
  intent: ChatIntent
): Promise<{ model: string; basis: 'telemetry' | 'eval' | 'profile' }> {
  // Use user outcomes/evals only when enabled and only among models that are
  // currently configured and ready. This keeps Auto explainable and prevents
  // stale scores from selecting a removed provider.
  if (settings.evals?.useScoresForRouting) {
    const candidates = [
      ...(isExactBuiltinReady('builtin:composer-lite') ? ['builtin:composer-lite'] : []),
      ...(isExactBuiltinReady('builtin:composer') ? ['builtin:composer'] : []),
      ...getLocalStatuses()
        .filter((m) => m.ready && isLocalRef(m.ref))
        .map((m) => m.ref),
      ...settings.models.connections
        .filter((c) => c.enabled && c.type !== 'builtin')
        .flatMap((c) => c.models.filter((name) => name.trim()))
    ]
    if (candidates.length) {
      const { bestModelForIntent } = await import('./agent-telemetry')
      const telemetryModel = bestModelForIntent(intent, candidates, settings.evals.minRuns)
      if (telemetryModel) return { model: telemetryModel, basis: 'telemetry' }
      const { bestEvalModelForIntent } = await import('./eval-store')
      const evalModel = bestEvalModelForIntent(intent, candidates, settings.evals.minRuns)
      if (evalModel) return { model: evalModel, basis: 'eval' }
    }
  }
  const heavy = intent === 'edit' || intent === 'verify' || intent === 'run'
  const profile = settings.agent.routing.profile ?? 'auto'
  const localFull = localComposerFullActive(settings)
  const preferCloud =
    !localFull && profile !== 'local' && settings.agent.routing.preferCloudComposer !== false
  if (heavy && (localFull || preferCloud)) return { model: 'builtin:composer', basis: 'profile' }
  if (isExactBuiltinReady('builtin:composer-lite')) {
    return { model: 'builtin:composer-lite', basis: 'profile' }
  }
  const fitted = await readyLocalHandoffRef(settings)
  if (fitted) return { model: fitted, basis: 'profile' }
  for (const conn of settings.models.connections) {
    if (!conn.enabled || conn.type === 'builtin') continue
    const name = conn.models.find((model) => model.trim())
    if (name) return { model: name, basis: 'profile' }
  }
  return { model: 'builtin:composer-lite', basis: 'profile' }
}

export function resolveModelRoles(options: {
  selectedModel: string
  intent: ChatIntent
  toolPolicy: AgentToolsCeiling
  preferEscalate: boolean
}): { chat: string; tools: string; escalateToFull: boolean; error?: string } {
  const selected = options.selectedModel.trim() || 'builtin:composer-lite'
  void options.toolPolicy
  void options.preferEscalate
  void options.intent

  if (isLocalRef(selected)) {
    const ready = resolveExactLocalRef(selected)
    if (!ready) {
      return {
        chat: selected,
        tools: selected,
        escalateToFull: false,
        error: `Local model “${selected}” is not ready. Download it in Settings → Models → Local.`
      }
    }
    return { chat: ready, tools: ready, escalateToFull: false }
  }

  if (!isBuiltinRef(selected)) {
    return { chat: selected, tools: selected, escalateToFull: false }
  }

  const exact = resolveExactBuiltinRef(selected)
  if (selected === 'builtin:composer' || selected === 'composer') {
    return { chat: 'builtin:composer', tools: 'builtin:composer', escalateToFull: false }
  }
  if (!exact) {
    return {
      chat: selected,
      tools: selected,
      escalateToFull: false,
      error: `Model “${selected}” is not ready. Download it in Settings → Models.`
    }
  }

  // Desktop runs Composer Lite locally. Composer Full is the Cloud Agents model
  // and stays selected so the chat can send the turn there.
  return { chat: exact, tools: exact, escalateToFull: false }
}

function formatReason(parts: {
  method: TurnPlan['method']
  agentName: string
  intent: ChatIntent
  chat: string
  tools: string
  escalateToFull: boolean
  profile?: 'auto' | 'local' | 'max'
  cloudPreferred?: boolean
}): string {
  const chatShort = parts.chat.replace(/^builtin:/, '')
  const toolsShort = parts.tools.replace(/^builtin:/, '')
  const modelBit =
    parts.escalateToFull || parts.chat !== parts.tools
      ? `${chatShort} → tools:${toolsShort}`
      : chatShort
  const profileBit = parts.profile === 'max' ? 'Max' : parts.profile === 'local' ? 'Local' : 'Auto'
  const cloudBit = parts.cloudPreferred ? ' · Cloud' : ''
  const label: Record<TurnPlan['method'], string> = {
    manual: 'Manual',
    llm: 'LLM',
    heuristic: 'Auto',
    default: 'Auto',
    override: 'Override',
    learned: 'Learned',
    eval: 'Eval',
    telemetry: 'Usage',
    handoff: 'Handoff'
  }
  return `${profileBit}${cloudBit} · ${label[parts.method]} → ${parts.agentName} · ${parts.intent} · ${modelBit}`
}

async function llmRouteHint(options: {
  settings: AppSettings
  text: string
  previousMessages?: Array<{ role: 'user' | 'assistant'; content: string; agentId?: string }>
  agents: AgentDefinition[]
  getSecret: (key: string) => string | null
  signal?: AbortSignal
  examples?: string
}): Promise<{ intent?: ChatIntent; agentId?: string; confidence: number } | null> {
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

  const agentLines = options.agents
    .map((a) => `- ${a.id}: ${a.description || a.name} (tools: ${a.tools ?? 'edit'})`)
    .join('\n')
  const history = (options.previousMessages ?? [])
    .slice(-6)
    .map(
      (message) =>
        `${message.role}${message.agentId ? ` (${message.agentId})` : ''}: ${message.content.slice(0, 600)}`
    )
    .join('\n')
  const prompt =
    `Classify this Eris IDE chat message for routing. Reply with ONLY JSON:\n` +
    `{"intent":"answer|capability|explore|plan|edit|review|verify|run","agentId":"<id>","confidence":0-1}\n\n` +
    `Intent definitions:\n` +
    `- answer — pure Q&A from knowledge; no workspace tools needed\n` +
    `- capability — questions about Eris itself, its models, providers, or limits\n` +
    `- explore — find/read/explain code in the workspace (tools: read)\n` +
    `- plan — inspect the workspace and return a sequenced implementation plan (tools: read; no edits)\n` +
    `- edit — create, change, improve, fix, or scaffold files (tools: write)\n` +
    `- review — critique / review project or PR code (tools: read); if they also ask to improve/fix, prefer edit\n` +
    `- verify — adversarially validate an implementation with relevant tests/typecheck (read + verification commands only; no edits)\n` +
    `- run — execute tests/builds/commands\n\n` +
    `Rules:\n` +
    `- "review the project… make improvements" → edit\n` +
    `- "review the project folder" alone → review\n` +
    `- Prefer edit over answer whenever the user wants changes in the repo\n` +
    `- Pick the best agentId from the list\n\n` +
    `Agents:\n${agentLines}\n` +
    (options.examples ? `Past corrections from this user:\n${options.examples}\n` : '') +
    (history ? `Recent conversation (for references only):\n${history}\n\n` : '') +
    `Current message:\n${options.text.slice(0, 1200)}`

  try {
    let out = ''
    for await (const chunk of streamModelChat({
      settings: options.settings,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are Eris’s turn router. Output a single compact JSON object only — no markdown, no prose.'
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
      confidence?: number
    }
    if (typeof parsed.confidence === 'number' && parsed.confidence < LLM_MIN_CONFIDENCE) {
      return null
    }
    const intents: ChatIntent[] = [
      'answer',
      'capability',
      'explore',
      'plan',
      'edit',
      'review',
      'verify',
      'run'
    ]
    const intent = intents.includes(parsed.intent as ChatIntent)
      ? (parsed.intent as ChatIntent)
      : undefined
    const agentId =
      parsed.agentId && options.agents.some((a) => a.id === parsed.agentId)
        ? parsed.agentId
        : undefined
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    return { intent, agentId, confidence }
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
  const forceRoute = options.context.forceRoute
  const mode = forceRoute === 'tools' ? 'agent' : options.context.mode === 'ask' ? 'ask' : 'agent'
  const text = options.context.text || ''
  const corrections = readRoutingCorrections()
  const pickedModel = options.context.selectedModel.trim()
  const selectedModel =
    pickedModel || options.settings.models.defaultModel || 'builtin:composer-lite'

  const heuristicIntent =
    options.context.resolvedIntent ?? classifyIntent(text, mode, options.context.fileNames || [])

  const route: RouteResult = await routeMessage({
    workspacePath: options.workspacePath,
    settings: options.settings,
    text,
    fileNames: options.context.fileNames || [],
    manualAgentId: options.context.manualAgentId
  })

  let agent =
    findAgent(options.workspacePath, route.agentId) || allAgentsFlat(options.workspacePath)[0]

  let method: TurnPlan['method'] = route.method
  let intent = heuristicIntent

  const routingProfile = options.settings.agent.routing.profile ?? 'auto'
  const preferCloudSetting = options.settings.agent.routing.preferCloudComposer !== false
  // Auto/Max profiles turn on the LLM router even if the legacy toggle is off.
  const wantLlmRouter =
    options.settings.agent.routing.useLlmRouter ||
    routingProfile === 'auto' ||
    routingProfile === 'max'

  const roster = allAgentsFlat(options.workspacePath)
  let llmAgentSelected = false

  const routeScore = Number(route.reason.match(/Matched keywords \(score (\d+)\)/)?.[1] || 0)
  const explicitIntent =
    asksToImplementChanges(text) ||
    asksForPlan(text) ||
    asksForVerification(text) ||
    asksForRecommendations(text) ||
    needsWebLookup(text) ||
    isErisCapabilityQuestion(text)
  const deterministicRouteIsClear = explicitIntent || routeScore >= 3

  // The model router may refine intent and select any available role. If it
  // times out or declines to choose, the deterministic role mapping below wins.
  if (
    mode === 'agent' &&
    options.settings.agent.routing.enabled &&
    wantLlmRouter &&
    !options.context.manualAgentId &&
    !options.context.skipModelRouter &&
    !deterministicRouteIsClear
  ) {
    const agents = roster.filter((a) => a.enabled)
    // Bound router latency and cancel its provider stream when the user turn has
    // enough information to proceed without the hint.
    const routeController = new AbortController()
    const abortRoute = () => routeController.abort(options.signal?.reason)
    if (options.signal?.aborted) abortRoute()
    else options.signal?.addEventListener('abort', abortRoute, { once: true })
    let routeTimer: ReturnType<typeof setTimeout> | undefined
    let hint: Awaited<ReturnType<typeof llmRouteHint>>
    try {
      hint = await Promise.race([
        llmRouteHint({
          settings: options.settings,
          text,
          previousMessages: options.context.previousMessages,
          agents,
          getSecret: options.getSecret,
          signal: routeController.signal,
          examples: routingExamples(corrections)
        }),
        new Promise<null>((resolve) => {
          routeTimer = setTimeout(() => {
            routeController.abort()
            resolve(null)
          }, 500)
        })
      ])
    } finally {
      if (routeTimer) clearTimeout(routeTimer)
      options.signal?.removeEventListener('abort', abortRoute)
      if (!routeController.signal.aborted) routeController.abort()
    }
    if (hint?.intent) {
      // Don't let a weak/cold router strip tools from "review/improve the project…"
      const llmStripsTools =
        intentNeedsTools(heuristicIntent) &&
        !intentNeedsTools(hint.intent) &&
        hint.intent !== 'capability'
      // Explicit requests to apply changes outrank a router that labels the
      // same follow-up as another review. Preserve the deterministic edit route.
      const llmDowngradesExplicitEdit =
        asksToImplementChanges(text) && heuristicIntent === 'edit' && hint.intent !== 'edit'
      if (!llmStripsTools && !llmDowngradesExplicitEdit) {
        intent = hint.intent
        method = 'llm'
      }
    }
    if (hint?.agentId) {
      const picked = findAgent(options.workspacePath, hint.agentId)
      const minConfidence =
        picked?.builtin === false ? CUSTOM_AGENT_MIN_CONFIDENCE : LLM_MIN_CONFIDENCE
      if (picked?.enabled && hint.confidence >= minConfidence) {
        agent = picked
        method = 'llm'
        llmAgentSelected = true
      }
    }
  }

  // Capability always wins over LLM misclassifies
  if (isErisCapabilityQuestion(text)) intent = 'capability'

  // Explicit specialist asks outrank router hints and learned corrections.
  // A pinned agent still remains the user's selected role.
  const explicitSpecialistIntent =
    !isErisCapabilityQuestion(text) && asksForPlan(text)
      ? 'plan'
      : !isErisCapabilityQuestion(text) && asksForVerification(text)
        ? 'verify'
        : null
  if (explicitSpecialistIntent && !options.context.manualAgentId) {
    intent = explicitSpecialistIntent
    method = 'heuristic'
    llmAgentSelected = false
    const specialistId = explicitSpecialistIntent === 'plan' ? 'planner' : 'verifier'
    agent = roster.find((candidate) => candidate.enabled && candidate.id === specialistId) || agent
  }

  const classifiedIntent = intent
  const correction =
    forceRoute ??
    (mode === 'agent' &&
    !options.context.resolvedIntent &&
    !asksToImplementChanges(text) &&
    !explicitSpecialistIntent
      ? learnedRouteFor(text, corrections)
      : null)
  if (correction === 'answer') {
    intent = 'answer'
  } else if (correction === 'tools' && !intentNeedsTools(intent)) {
    intent = 'edit'
  }
  if (correction && intent !== classifiedIntent) {
    method = forceRoute ? 'override' : 'learned'
  }

  const followId = agentForFollowUp(text, options.context.previousAgentId)
  if (
    mode === 'agent' &&
    followId &&
    !explicitSpecialistIntent &&
    !options.context.resolvedIntent
  ) {
    const previousUserText =
      [...(options.context.previousMessages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')?.content || ''
    const previousIntent = previousUserText ? classifyIntent(previousUserText, 'agent') : null
    const isContinuation =
      isConversationFollowUp(text) &&
      !intentNeedsTools(intent) &&
      !needsWebLookup(text) &&
      !asksToImplementChanges(text) &&
      !/\b(fix|change|edit|implement|update|apply)\b/i.test(text)
    if (
      isContinuation &&
      previousIntent &&
      previousIntent !== 'answer' &&
      previousIntent !== 'capability'
    ) {
      intent = previousIntent
    } else if (followId === 'composer') intent = 'edit'
    else if (followId === 'reviewer') intent = 'review'
    else if (followId === 'explainer' || followId === 'fast') intent = 'explore'
  }

  // Auto chat uses the roster contract. A pinned agent, a learned/forced
  // correction, and a winning custom agent are left as chosen.
  if (
    !options.context.manualAgentId &&
    !llmAgentSelected &&
    (method === 'heuristic' || method === 'llm') &&
    agent?.builtin !== false
  ) {
    const defined = findAgent(
      options.workspacePath,
      chatAgentForTurn({
        mode,
        intent,
        text,
        previousAgentId: options.context.previousAgentId
      })
    )
    if (defined?.enabled) {
      agent = defined
      method = 'heuristic'
    }
  }

  if (correction === 'tools' && agent && CEILING_RANK[agent.tools ?? 'edit'] < CEILING_RANK.edit) {
    const fallback = findAgent(
      options.workspacePath,
      options.settings.agent.routing.fallbackAgentId
    )
    if (fallback?.enabled && CEILING_RANK[fallback.tools ?? 'edit'] >= CEILING_RANK.edit) {
      agent = fallback
    }
  }

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

  // A mutating intent needs an agent that can actually mutate. A weak model
  // router may choose Reviewer for a coding follow-up even after intent has
  // been corrected to edit; never let that become an edit plan with read-only
  // tools and a prompt that tells the worker not to edit.
  const requiredMutationCeiling = intent === 'run' ? 'full' : 'edit'
  if (
    mode === 'agent' &&
    intentNeedsMutation(intent) &&
    CEILING_RANK[agent.tools ?? 'edit'] < CEILING_RANK[requiredMutationCeiling]
  ) {
    const editor =
      roster.find((candidate) => candidate.enabled && candidate.id === 'composer') ||
      roster.find(
        (candidate) =>
          candidate.enabled &&
          CEILING_RANK[candidate.tools ?? 'edit'] >= CEILING_RANK[requiredMutationCeiling]
      )
    if (editor) {
      agent = editor
      llmAgentSelected = false
      method = 'heuristic'
    }
  }

  const toolPolicy = effectiveToolPolicy(agent, intent, mode)
  const agentModelOverride =
    (!pickedModel || isAutoModelChoice(pickedModel)) && agent.model.trim() && agent.model !== 'auto'
      ? agent.model.trim()
      : ''
  let modelBasis: 'user' | 'agent' | 'telemetry' | 'eval' | 'profile' = agentModelOverride
    ? 'agent'
    : 'user'
  let chosenModel = agentModelOverride || selectedModel
  if (isAutoModelChoice(chosenModel)) {
    const choice = await chooseAutoChatModel(options.settings, intent)
    chosenModel = choice.model
    modelBasis = choice.basis
  }
  const roles = resolveModelRoles({
    selectedModel: chosenModel,
    intent,
    toolPolicy,
    preferEscalate: agent.preferEscalate !== false
  })

  const requiresTools = toolPolicy !== 'none' && intentNeedsTools(intent)
  const usingComposerFull = roles.chat === 'builtin:composer' || roles.tools === 'builtin:composer'
  const localFull = localComposerFullActive(options.settings)
  const cloudPreferred =
    mode === 'agent' &&
    usingComposerFull &&
    routingProfile !== 'local' &&
    preferCloudSetting &&
    !localFull

  return {
    intent,
    agentId: agent.id,
    agentName: agent.name,
    mode,
    models: {
      chat: roles.chat,
      tools: roles.tools,
      router: wantLlmRouter ? options.settings.agent.routing.routerModel : undefined
    },
    toolPolicy,
    requiresTools,
    escalateToFull: roles.escalateToFull || (cloudPreferred && routingProfile === 'max'),
    reason: `${formatReason({
      method,
      agentName: agent.name,
      intent,
      chat: roles.chat,
      tools: roles.tools,
      escalateToFull: roles.escalateToFull,
      profile: routingProfile,
      cloudPreferred
    })} · model ${modelBasis}`,
    method,
    classifiedIntent,
    error: roles.error,
    routingProfile,
    cloudPreferred,
    executionPlan: executionPlanFor(mode, intent)
  }
}

function executionPlanFor(
  mode: 'ask' | 'agent',
  intent: ChatIntent
): { steps: string[]; doneWhen: string } {
  if (intent === 'capability') {
    return {
      steps: ['Check Eris model and provider catalog'],
      doneWhen: 'Answer from the current catalog.'
    }
  }
  if (intent === 'plan') {
    return {
      steps: [
        'Inspect the relevant sources and project conventions',
        'Trace dependencies and integration points',
        'Return ordered steps with files, risks, and completion checks'
      ],
      doneWhen:
        'The plan is grounded in inspected files and clearly distinguishes decisions from assumptions.'
    }
  }
  if (intent === 'verify') {
    return {
      steps: [
        'Inspect the implementation and relevant tests',
        'Probe likely edge cases and failure paths',
        'Run relevant approved verification commands',
        'Report observed results and remaining risks'
      ],
      doneWhen:
        'Every claimed result is supported by inspection or command output, with no files edited.'
    }
  }
  if (mode === 'ask' || intent === 'explore') {
    return {
      steps: [
        'Find relevant workspace sources',
        'Read the matching files',
        'Answer with paths and evidence'
      ],
      doneWhen: 'The answer is grounded in the files that were read.'
    }
  }
  if (intent === 'review') {
    return {
      steps: [
        'Map the requested scope',
        'Inspect relevant implementation and tests',
        'Rank findings with evidence'
      ],
      doneWhen: 'Each finding has a path, impact, and actionable fix.'
    }
  }
  if (intent === 'run') {
    return {
      steps: [
        'Inspect the requested run target if needed',
        'Run it with required approval',
        'Report the result'
      ],
      doneWhen: 'The command result and any remaining failure are stated accurately.'
    }
  }
  return {
    steps: [
      'Inspect affected code and project rules',
      'Make the requested changes',
      'Run relevant verification',
      'Summarize the diff'
    ],
    doneWhen: 'The requested behavior is implemented and verification results are reported.'
  }
}

/** Legacy RouteResult from a TurnPlan (status bar / older callers). */
export function turnPlanToRouteResult(plan: TurnPlan): RouteResult {
  return {
    agentId: plan.agentId,
    agentName: plan.agentName,
    model: plan.models.chat,
    reason: plan.reason,
    method:
      plan.method === 'override'
        ? 'manual'
        : plan.method === 'learned' ||
            plan.method === 'eval' ||
            plan.method === 'telemetry' ||
            plan.method === 'handoff'
          ? 'heuristic'
          : plan.method
  }
}

// Re-export heuristic agent scoring for tests / thin router
export { routeHeuristic }
