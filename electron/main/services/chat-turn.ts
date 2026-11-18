import { helperModel } from './helper-model'
import { modelDestination } from './model-destination'
import { bindTaskReferences, type ResolvedReference } from './reference-binding'
import { realpathSync } from 'fs'
import { relative, resolve } from 'path'
import { isPathInside } from './workspace-fs'
import type {
  AppSettings,
  ChatIntent,
  ChatPromptInput,
  TurnPlan
} from '../../../src/shared/settings-schema'
import {
  interpretationOf,
  taskIntakeBlocked,
  type IntentResolution,
  type TaskContract,
  type RequirementProgress,
  type TaskTurnResult
} from '../../../src/shared/task-contract'
import {
  extractRecommendations,
  recommendationAccounting,
  stableHash
} from '../../../src/shared/recommendations'
import type { AgentRunnerEvent } from './agent/types'
import { buildChatMessages, type BuiltChatMessage } from './chat-prompt'
import type { ContextAllocation } from '../../../src/shared/context-allocation'
import { planChatTurn } from './chat-router'
import { asksToResumeFileRequirements, createTaskContract } from './task-intake'
import { resolveTaskDecision } from './task-resolver'
import { executionPlanFor } from './execution-plan'
import { appendTaskEvent } from './task-ledger'
import { previousTask } from './task-store'
import { prepareModelWindows } from './ollama-runtime'
import { implicitHtmlElement } from './task-intake'

/**
 * Production chat turn pipeline shared by the chat IPC handler and in-app
 * diagnostics: route → semantic re-resolution → task contract → prompt →
 * agent model → outcome evidence. Callers own transport, approvals, and
 * persistence; this module owns the task logic so it is never reimplemented.
 */
export interface ChatTurnInput {
  referenceBinding?: ResolvedReference
  requestId: string
  workspacePath: string | null
  settings: AppSettings
  text: string
  /** Renderer-selected model; empty means the settings default. */
  model: string
  mode?: 'ask' | 'agent'
  manualAgentId?: string | null
  fileNames?: string[]
  openFilePath?: string
  askTarget?: (question: string, choices: string[]) => Promise<string | null>
  previousAgentId?: string | null
  forceRoute?: 'tools' | 'answer'
  preserveModelSelection?: boolean
  history?: ChatPromptInput['history']
  threadId?: string | null
  skillIds?: string[]
  getSecret: (key: string) => string | null
  signal?: AbortSignal
  /** Diagnostics only: a shorter semantic-resolver deadline. */
  resolverTimeoutMs?: number
  /**
   * Diagnostics only: the previous turn's task, instead of the thread's stored
   * task. Null means “no prior task”; undefined reads the store.
   */
  priorTask?: TaskContract | null
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
    deferAutoWorker: true,
    workspacePath: input.workspacePath,
    settings: input.settings,
    context: {
      text: input.text,
      fileNames: input.fileNames,
      selectedModel: input.model || input.settings.models.defaultModel,
      mode: input.mode === 'ask' ? 'ask' : 'agent',
      manualAgentId: input.manualAgentId ?? null,
      previousAgentId: input.previousAgentId ?? null,
      skipModelRouter: true,
      forceRoute: input.forceRoute,
      preserveModelSelection: input.preserveModelSelection,
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
  let canonicalRoot = input.workspacePath
  try {
    if (input.workspacePath) canonicalRoot = realpathSync(input.workspacePath)
  } catch {
    /* reported by runtime */
  }
  const deferred = !initial.models.chat && !initial.error && initial.modelExecution?.policy !== 'fixed'
  let references = input.referenceBinding
  if (!references && input.threadId && input.priorTask === undefined) {
    try {
      references = await bindTaskReferences({
        root: canonicalRoot,
        threadId: input.threadId,
        text: input.text,
        settings: input.settings,
        models: deferred ? [] : [plan.models.chat, plan.models.tools],
        recentSourceIds: input.history?.flatMap((message) => (message.id ? [message.id] : [])),
        latestAssistantId: [...(input.history ?? [])].reverse().find((message) => message.role === 'assistant')?.id
      })
    } catch {
      input.signal?.throwIfAborted()
      references = {
        binding: {
          status: 'unavailable',
          remotePolicy: 'local-only',
          sources: [],
          reason: 'Historical references could not be checked; clarify before editing.'
        },
        recommendations: []
      }
    }
  }
  const priorTask = input.priorTask !== undefined
    ? (input.priorTask ?? undefined)
    : previousTask(canonicalRoot, input.threadId ?? null)
  const taskInput = {
    referenceBinding: references,
    taskId: input.requestId,
    threadId: input.threadId,
    workspacePath: input.workspacePath,
    text: input.text,
    skillIds: input.skillIds,
    history: input.history,
    openFilePath: input.openFilePath,
    priorTask
  }
  const pageTask = plan.mode === 'agent' && plan.intent === 'edit' && implicitHtmlElement(input.text)
    ? createTaskContract({ ...taskInput, plan }) : undefined
  let selectedEditTarget: string | undefined
  const question = pageTask?.requested?.targetQuestion
  if (question && input.askTarget) {
    const reply = await input.askTarget(question.text, question.choices)
    input.signal?.throwIfAborted()
    if (reply && question.choices.includes(reply))
      selectedEditTarget = reply
  }
  const pageBound = pageTask?.requested?.targetQuestion || pageTask?.requested?.targetReason
  const selectedHelper = helperModel(input.settings, plan, 'resolve')
  const coordinatorModel = selectedHelper || plan.models.tools || plan.models.chat
  const skipInference = input.settings.agent.helperCalls === 'off'
    ? 'helper-calls-disabled'
    : !selectedHelper
      ? 'cold-native-routing-skipped'
      : undefined
  const resolution: IntentResolution = !input.forceRoute && asksToResumeFileRequirements(input.text)
    ? { intent: 'edit', initialIntent: plan.intent, source: 'forced', rule: 'resume-file-requirements', durationMs: 0 }
    : input.forceRoute || pageBound
    ? {
        intent: plan.intent,
        initialIntent: plan.intent,
        source: 'forced',
        rule: pageBound ? 'html-target-intake' : `force-route:${input.forceRoute}`,
        durationMs: 0
      }
    : await resolveTaskDecision({
        text: input.text,
        fallback: plan.intent,
        settings: input.settings,
        model: coordinatorModel,
        mode: input.mode ?? 'agent',
        history: input.history,
        omitModelHistory: !modelDestination(input.settings, coordinatorModel).recallAllowed &&
          input.settings.agent.contextMemory?.shareWithRemoteModels !== true,
        signal: input.signal,
        getSecret: input.getSecret,
        timeoutMs: input.resolverTimeoutMs,
        skipInference,
        reference: references && {
          status: references.binding.status,
          paths: references.recommendations.flatMap(item => item.targets ?? [])
        }
      })
  const semanticIntent = resolution.intent
  if (deferred || semanticIntent !== plan.intent) {
    const referenceChars = references?.binding.status === 'bound'
      ? references.recommendations.reduce((size, item) => size + item.text.length +
          (item.targets ?? []).reduce((total, path) => total + path.length + 4, 0), 0) : 0
    plan = await planChatTurn({
      requiredContext: referenceChars ? Math.ceil((input.text.length + referenceChars) / 3) + 512 : undefined,
      workspacePath: input.workspacePath,
      settings: input.settings,
      context: {
        text: input.text,
        mode: input.mode ?? 'agent',
        selectedModel: deferred && references?.binding.remotePolicy === 'local-only'
          ? 'auto-local' : input.model || input.settings.models.defaultModel,
        manualAgentId: input.manualAgentId ?? null,
        resolvedIntent: semanticIntent,
        fileNames: input.fileNames,
        previousAgentId: input.previousAgentId ?? null,
        skipModelRouter: true,
        forceRoute: input.forceRoute,
        preserveModelSelection: input.preserveModelSelection,
        previousMessages: previousMessages(input.history)
      },
      getSecret: input.getSecret,
      signal: input.signal
    })
  }
  if (resolution.source === 'semantic') plan = { ...plan, models: { ...plan.models, coordinator: coordinatorModel } }
  const task = createTaskContract({ ...taskInput, plan, resolution, selectedEditTarget })
  plan.task = task
  // Reference and scope problems are cheap intake results, not model-load requests.
  const preparationModels = !plan.error && !taskIntakeBlocked(task, plan.mode) &&
      (task.scope.state === 'resolved' || task.scope.applicability === 'generic')
    ? [...new Set([plan.models.chat, plan.models.tools].filter(Boolean))] : []
  const preparationStarted = Date.now()
  if (preparationModels.length)
    await prepareModelWindows(input.settings, preparationModels, input.getSecret, input.signal)
  // The workflow follows the resolved scope: a generic request has no inspection step.
  if (plan.executionPlan)
    plan.executionPlan = executionPlanFor(plan.mode, plan.intent, task.scope.applicability)
  // One decision record: initial route, resolver outcome, final route and resulting effects.
  appendTaskEvent(task.taskId, 'route-decision', {
    revision: task.revision,
    initial: { intent: initial.intent, agentId: initial.agentId, trace: initial.routeTrace },
    resolution,
    preparation: { models: preparationModels, windowRequests: preparationModels.length, durationMs: Date.now() - preparationStarted },
    final: {
      intent: plan.intent,
      agentId: plan.agentId,
      toolPolicy: plan.toolPolicy,
      trace: plan.routeTrace
    },
    requested: task.requested,
    interpretation: task.interpretation,
    authority: task.authority
  })
  return { plan, task, semanticIntent, resolution }
}

/**
 * Record what a turn produced on its task, so the next turn in the thread can
 * refer to it: recommendations as stable objects and the files actually changed.
 */
function observedRequirements(task: TaskContract, changedFiles: string[]): RequirementProgress[] {
  const { workspaceRoot, projectRoot } = task.scope
  if (!workspaceRoot || !projectRoot || task.requested?.artifact !== 'patch') return []
  const prefix = relative(workspaceRoot, projectRoot).replace(/\\/g, '/')
  const recorded = new Set(changedFiles.map((name) => resolve(workspaceRoot, name)))
  const known = (name: string) => {
    const path = name.replace(/\\/g, '/')
    const full = resolve(prefix && path.startsWith(prefix + '/') ? workspaceRoot : projectRoot, path)
    return isPathInside(projectRoot, full) && recorded.has(full)
  }
  const items = task.recommendations.length
    ? task.recommendations.map((item) => ({ id: item.id, text: item.text, paths: item.targets ?? [], artifactOnly: false }))
    : (task.requested.targetFiles ?? []).map((path, index) => ({
        id: `file-${index + 1}`, text: `Change ${path}`, paths: [path], artifactOnly: true
      }))
  return items.map((item) => {
    const evidencePaths = item.paths.filter(known)
    const remainingPaths = item.paths.filter((path) => !evidencePaths.includes(path))
    const state = !task.authority.edit || task.requested?.state !== 'resolved' ? 'blocked'
      : item.artifactOnly && !remainingPaths.length ? 'satisfied'
      : evidencePaths.length ? 'partial' : 'not-attempted'
    return { id: item.id, text: item.text, state, evidencePaths, remainingPaths }
  })
}

export function completeChatTurnTask(
  task: TaskContract,
  outcome: { answer: string; changedFiles: string[]; terminal: TaskTurnResult['terminal'] }
): TaskContract {
  const requirements = observedRequirements(task, outcome.changedFiles)
  const missingTargets = requirements.some((item) => item.remainingPaths.length)
  const offersAdvice =
    ['review', 'plan'].includes(task.deliverable) ||
    ['review', 'plan', 'design'].includes(interpretationOf(task).artifact)
  return {
    ...task,
    result: {
      terminal: outcome.terminal === 'complete' && task.requested &&
        (missingTargets || task.requested.state !== 'resolved' ||
          (task.requested.artifact === 'patch' && (!task.authority.edit || outcome.changedFiles.length === 0)))
        ? 'incomplete' : outcome.terminal,
      offeredRecommendations: offersAdvice ? extractRecommendations(outcome.answer) : [],
      changedFiles: [...new Set(outcome.changedFiles)].sort(),
      answerDigest: stableHash(outcome.answer),
      ...(requirements.length ? { requirements } : {}),
      ...(task.recommendations.length && task.deliverable === 'patch'
        ? { recommendationStatus: recommendationAccounting(outcome.answer, task.recommendations) }
        : {})
    }
  }
}

/** Role instructions are generated for the resolved route, never the renderer's guess. */
export function buildChatTurnMessages(
  workspacePath: string | null,
  settings: AppSettings,
  prompt: ChatPromptInput,
  plan: TurnPlan,
  threadId?: string | null,
  allocation?: ContextAllocation
): BuiltChatMessage[] {
  return buildChatMessages(
    workspacePath,
    settings,
    {
      ...prompt,
      mode: plan.mode,
      agentId: plan.agentId,
      agentName: plan.agentName,
      threadId: threadId ?? prompt.threadId
    },
    {
      genericScope: plan.task?.scope.applicability === 'generic',
      allocation,
      // A no-tool answer cannot look the changes up, so give it the record (#504).
      ...(plan.toolPolicy === 'none' && plan.task?.continuation
        ? { priorChangedFiles: plan.task.continuation.changedFiles }
        : {})
    }
  )
}

const OUTCOME_EVIDENCE_TOOLS = ['read_file', 'notebook_read', 'run', 'search_replace', 'write_file']

/** Observed tool results and diffs that the semantic outcome review may rely on. */
/** A file this run changed, for the outcome review (#501). */
export type OutcomeChange = {
  path: string
  op: 'create' | 'modify' | 'delete' | 'rename' | 'mkdir' | 'binary'
  /** Bounded excerpt of the new content. */
  excerpt: string
}

const CHANGE_EXCERPT_CHARS = 1_500
const MAX_CHANGES = 6

export class OutcomeEvidence {
  readonly items: string[] = []
  private changed = new Map<string, OutcomeChange>()

  /** Files changed in this run, latest state per path, from the diff events (#501). */
  get changes(): OutcomeChange[] {
    return [...this.changed.values()].slice(-MAX_CHANGES)
  }

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
      const op: OutcomeChange['op'] =
        evt.diff.op === 'write' ? (evt.diff.before === null ? 'create' : 'modify') : evt.diff.op
      const created = this.changed.get(evt.diff.path)?.op === 'create'
      this.changed.delete(evt.diff.path)
      this.changed.set(evt.diff.path, {
        path: evt.diff.path,
        op: created && op === 'modify' ? 'create' : op,
        excerpt: op === 'delete' ? '' : (evt.diff.after ?? '').slice(0, CHANGE_EXCERPT_CHARS)
      })
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
