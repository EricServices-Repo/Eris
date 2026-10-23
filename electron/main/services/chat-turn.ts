import { realpathSync } from 'fs'
import type {
  AppSettings,
  ChatIntent,
  ChatPromptInput,
  TurnPlan
} from '../../../src/shared/settings-schema'
import type { IntentResolution, TaskContract } from '../../../src/shared/task-contract'
import type { AgentRunnerEvent } from './agent/types'
import { buildChatMessages, type BuiltChatMessage } from './chat-prompt'
import { localComposerFullActive, planChatTurn } from './chat-router'
import { createTaskContract } from './task-intake'
import { resolveTaskDecision } from './task-resolver'
import { appendTaskEvent } from './task-ledger'
import { previousTask } from './task-store'

/**
 * Production chat turn pipeline shared by the chat IPC handler and in-app
 * diagnostics: route → semantic re-resolution → task contract → prompt →
 * agent model → outcome evidence. Callers own transport, approvals, and
 * persistence; this module owns the task logic so it is never reimplemented.
 */
export interface ChatTurnInput {
  requestId: string
  workspacePath: string | null
  settings: AppSettings
  text: string
  /** Renderer-selected model; empty means the settings default. */
  model: string
  mode?: 'ask' | 'agent'
  manualAgentId?: string | null
  previousAgentId?: string | null
  forceRoute?: 'tools' | 'answer'
  history?: ChatPromptInput['history']
  threadId?: string | null
  skillIds?: string[]
  getSecret: (key: string) => string | null
  signal?: AbortSignal
  /** Diagnostics only: a shorter semantic-resolver deadline. */
  resolverTimeoutMs?: number
}

function previousMessages(history: ChatPromptInput['history'] | undefined) {
  return history?.flatMap((message) =>
    message.role === 'system'
      ? []
      : [{ role: message.role, content: message.content, agentId: message.agentId }]
  )
}

/** Deterministic first route for the turn; the model router is skipped as in chat. */
export function planInitialChatTurn(input: ChatTurnInput): Promise<TurnPlan> {
  return planChatTurn({
    workspacePath: input.workspacePath,
    settings: input.settings,
    context: {
      text: input.text,
      selectedModel: input.model || input.settings.models.defaultModel,
      mode: input.mode === 'ask' ? 'ask' : 'agent',
      manualAgentId: input.manualAgentId ?? null,
      previousAgentId: input.previousAgentId ?? null,
      skipModelRouter: true,
      forceRoute: input.forceRoute,
      previousMessages: previousMessages(input.history)
    },
    getSecret: input.getSecret,
    signal: input.signal
  })
}

/**
 * Re-resolve the request's meaning independently of the routed worker, re-plan
 * when it differs, and attach the immutable task contract to the plan.
 */
export async function resolveChatTurnContract(
  input: ChatTurnInput,
  initial: TurnPlan
): Promise<{
  plan: TurnPlan
  task: TaskContract
  semanticIntent: ChatIntent
  resolution: IntentResolution
}> {
  let plan = initial
  const resolution: IntentResolution = input.forceRoute
    ? {
        intent: plan.intent,
        initialIntent: plan.intent,
        source: 'forced',
        rule: `force-route:${input.forceRoute}`,
        durationMs: 0
      }
    : await resolveTaskDecision({
        text: input.text,
        fallback: plan.intent,
        settings: input.settings,
        model: plan.models.chat,
        mode: input.mode ?? 'agent',
        history: input.history,
        signal: input.signal,
        getSecret: input.getSecret,
        timeoutMs: input.resolverTimeoutMs
      })
  const semanticIntent = resolution.intent
  if (semanticIntent !== plan.intent) {
    plan = await planChatTurn({
      workspacePath: input.workspacePath,
      settings: input.settings,
      context: {
        text: input.text,
        mode: input.mode ?? 'agent',
        selectedModel: input.model,
        manualAgentId: input.manualAgentId ?? null,
        resolvedIntent: semanticIntent,
        skipModelRouter: true,
        previousMessages: previousMessages(input.history)
      },
      getSecret: input.getSecret,
      signal: input.signal
    })
  }
  let canonicalRoot = input.workspacePath
  try {
    if (input.workspacePath) canonicalRoot = realpathSync(input.workspacePath)
  } catch {
    /* reported by runtime */
  }
  const task = createTaskContract({
    taskId: input.requestId,
    threadId: input.threadId,
    workspacePath: input.workspacePath,
    text: input.text,
    plan,
    skillIds: input.skillIds,
    history: input.history,
    priorTask: previousTask(canonicalRoot, input.threadId ?? null),
    resolution
  })
  plan.task = task
  // One decision record: initial route, resolver outcome, final route and resulting effects.
  appendTaskEvent(task.taskId, 'route-decision', {
    revision: task.revision,
    initial: { intent: initial.intent, agentId: initial.agentId, trace: initial.routeTrace },
    resolution,
    final: {
      intent: plan.intent,
      agentId: plan.agentId,
      toolPolicy: plan.toolPolicy,
      trace: plan.routeTrace
    },
    interpretation: task.interpretation,
    authority: task.authority
  })
  return { plan, task, semanticIntent, resolution }
}

/** Role instructions are generated for the resolved route, never the renderer's guess. */
export function buildChatTurnMessages(
  workspacePath: string | null,
  settings: AppSettings,
  prompt: ChatPromptInput,
  plan: TurnPlan,
  threadId?: string | null
): BuiltChatMessage[] {
  return buildChatMessages(workspacePath, settings, {
    ...prompt,
    mode: plan.mode,
    agentId: plan.agentId,
    agentName: plan.agentName,
    threadId: threadId ?? prompt.threadId
  })
}

/** Composer Full runs locally only when its local runtime is active; otherwise Lite. */
export function localChatTurnModel(
  plan: TurnPlan,
  model: string,
  settings: AppSettings
): { model: string; plan: TurnPlan } {
  if (
    (model === 'builtin:composer' || model === 'composer') &&
    !localComposerFullActive(settings)
  ) {
    const lite = 'builtin:composer-lite'
    return { model: lite, plan: { ...plan, models: { ...plan.models, chat: lite, tools: lite } } }
  }
  return { model, plan }
}

const OUTCOME_EVIDENCE_TOOLS = ['read_file', 'notebook_read', 'run', 'search_replace', 'write_file']

/** Observed tool results and diffs that the semantic outcome review may rely on. */
export class OutcomeEvidence {
  readonly items: string[] = []

  observe(evt: AgentRunnerEvent): void {
    if (
      evt.type === 'tool' &&
      evt.tool.status !== 'running' &&
      OUTCOME_EVIDENCE_TOOLS.includes(evt.tool.name)
    ) {
      this.items.push(
        `${evt.tool.name} ${evt.tool.path ?? ''}: ${evt.tool.status}\n${evt.tool.detail}`
      )
    } else if (evt.type === 'diff') {
      this.items.push(
        `Observed diff ${evt.diff.path}:\nBefore: ${(evt.diff.before ?? '').slice(0, 600)}\nAfter: ${(evt.diff.after ?? '').slice(0, 900)}`
      )
    }
  }

  addActions(actions: string[]): void {
    if (actions.length) this.items.push(actions.slice(-15).join('\n'))
  }
}

export function needsOutcomeReview(plan: TurnPlan, incomplete: boolean): boolean {
  return (
    !incomplete &&
    Boolean(plan.task) &&
    ['review', 'plan', 'edit', 'verify', 'run'].includes(plan.intent)
  )
}
