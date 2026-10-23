import { appendToolObservation } from '../model-protocol'
import { acquireProjectWrite } from './task-scheduler'
import { generateImage, saveImageToWorkspace } from '../image-generation'
import { ImageSizeSchema } from '../../../../src/shared/image-generation-schema'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import {
  asksForRecommendations,
  asksWhatTheProjectDoes,
  needsWebLookup
} from '../../../../src/shared/agent-contract'
import { isToolLogReply } from '../../../../src/shared/posted-answer'
import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { formatAvailableModelsPrompt } from '../model-catalog'
import {
  effectiveToolPolicy,
  filterToolsByPolicy,
  intentNeedsMutation,
  intentNeedsTools,
  isErisCapabilityQuestion,
  minCeiling,
  planChatTurn,
  toolAllowedByPolicy
} from '../chat-router'
import { callMcpTool, isMcpToolName, listMcpTools, syncMcpRuntime } from '../mcp-runtime'
import { workspaceGlob, workspaceGrep } from '../workspace-search'
import { inspectWorkspace } from '../workspace-intelligence'
import { findReferences, findSymbols, relatedFiles } from '../code-index'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  setContextSummary
} from '../workspace-context'
import { runVerify } from '../verify'
import type { OpenAIToolDef } from '../chat-runtime'
import {
  COMPOSER_OPENAI_TOOLS,
  getToolContract,
  MAX_INLINE_MCP_TOOLS,
  isVisibleCapability,
  resolveToolCapabilities,
  mcpToolsToOpenAI,
  toolCallJsonSchema
} from '../tool-registry'
import {
  createCheckpoint,
  recordBinaryCreateOp,
  getCheckpointOpCount,
  pruneOldCheckpoints,
  recordDeleteOp,
  recordMkdirOp,
  recordRenameOp,
  recordWriteOp,
  snapshotBeforeWrite
} from '../checkpoints'
import { runWorkspaceCommand } from '../shell-run'
import {
  applyUnifiedPatch,
  isPathInside,
  readWorkspaceFile,
  resolveInWorkspace,
  searchReplaceInFile,
  toWorkspaceRelative,
  unifiedPatchTargetPath
} from '../workspace-fs'
import { gitCommit, gitDiff, gitStage, gitStatus, gitStash } from '../git-service'
import { pushPullFetch, parseGithubRepo } from '../github'
import { invalidateDiagnosticsCache } from '../diagnostics'
import { formatSkillsListForAgent, getSkill, slugifySkillId, upsertSkill } from '../skills'
import { userSkillsDir } from '../paths'
import {
  buildWorkSummary,
  compactAgentMessages,
  contextBudgetTokens,
  microCompactAgentMessages,
  needsContextCompaction
} from './compaction'
import { executeTool } from './execute-tool'
import { validateToolArguments } from './tool-validation'
import {
  assessGoalCompletion,
  isReviewOnlyGoal,
  looksLikeAsksForWorkspaceInfo,
  looksLikeClarifyingQuestion,
  looksLikeDegenerateLoop,
  pathNeedsProjectVerify,
  shouldKeepWorking,
  toolFingerprint
} from './heuristics'
import {
  hasNodeModules,
  isGlobalInstallCommand,
  isInstallCommand,
  isPackageAddInstall,
  looksLikeMissingDeps,
  MAX_BARE_INSTALLS_PER_RUN,
  packageJsonNewerThanModules
} from './install-guards'
import { decideMidRunAdapt, MID_RUN_ADAPT_BUDGET, shouldConsiderMidRunAdapt } from './mid-run-adapt'
import { toolFailureRecovery } from './recovery'
import { findAgent } from '../agents'
import {
  AGENT_HANDOFF_CHARS,
  formatHandoffForPrompt
} from '../../../../src/shared/agent-orchestration'
import { isVerifyCommand } from '../command-approval'
import { buildPreservedWorkerMessages, isReadOnlyChat, truncateForModel } from './prompts'
import { createTaskContract, childTaskContract } from '../task-intake'
import {
  interpretationOf,
  intersectToolPolicy,
  taskContractConflicts,
  type TaskContract
} from '../../../../src/shared/task-contract'
import { artifactResponseContract } from '../../../../src/shared/task-interpretation'
import { compileTaskContext } from './context-compiler'
import { lintExecutionPlan } from './workflow-lint'
import { appendTaskEvent } from '../task-ledger'
import { TaskToolGateway } from './tool-gateway'
import {
  firstHttpsResult,
  httpsResults,
  replyFromWebEvidence,
  webSearchQuery
} from './web-grounding'
import { streamThinkingText } from './stream'
import { openWebPage, searchWeb } from '../web-search'
import {
  lspCompletion,
  lspDefinition,
  lspEnsureOpen,
  lspHover,
  lspReferences
} from '../language-servers'
import { editNotebookCell, readNotebook } from '../workspace-notebook'
import {
  argString,
  parseToolCalls,
  postedAnswer,
  proseOutsideTools,
  stripToolBlocks,
  thinkingBeforeTools
} from './tool-parsing'
import { isNativeGgufRef, releaseLocalChatSession } from '../builtin-model'
import { logInfo, logWarn } from '../logger'
import type { AgentChatMessage, AgentMode, AgentRunnerEvent, ToolCall } from './types'
import type { AgentHandoffPacket } from '../../../../src/shared/agent-orchestration'
import { AgentWorkflow } from './workflow'

/** Consecutive rounds with zero mutation → stronger finish nudge (never stops the run). */
const MAX_NO_PROGRESS = 8
/** Stop after this many failed verify rounds (mid-loop + final). */
const MAX_VERIFY_FAILURES = 3
/** Mid-loop verify cadence (final verify still runs once before DONE). */
const VERIFY_EVERY_N_MUTATIONS = 8
/** How many times we reject a premature DONE before stopping as incomplete. */
const MAX_GOAL_REJECTS = 3
/** Stop a broken worker before it can spend dozens of rounds on one action. */
const MAX_DUPLICATE_TOOL_BLOCKS = 4
/** Product files at or below this size count as stubs for goal checks. */
const STUB_FILE_MAX_BYTES = 250

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
}

function answerFromProjectFiles(reads: Array<{ path: string; text: string }>): string {
  if (reads.length === 0) return ''
  const body = reads
    .slice(0, 3)
    .map((file) => `**${file.path}**\n\n${file.text.trim().slice(0, AGENT_HANDOFF_CHARS)}`)
    .join('\n\n')
  return `From the project files:\n\n${body}`
}

type ToolExecutionResult = { ok: boolean; detail: string; mutated: boolean; path?: string }

export function toolFailureMetadata(
  detail: string,
  effect: 'read' | 'workspace' | 'external' | 'command' | 'orchestration'
): { code: string; retryable: boolean; cause?: string } {
  const code = /\bdenied\b|\bblocked\b|no approval handler|reviewer can only/i.test(detail)
    ? 'permission_denied'
    : /read required before editing/i.test(detail)
      ? 'precondition_failed'
      : /invalid arguments|is required|must be /i.test(detail)
        ? 'invalid_arguments'
        : /timed out/i.test(detail)
          ? 'timeout'
          : /not found|not connected|no .* available/i.test(detail)
            ? 'unavailable'
            : 'execution_failed'
  // A refused approval is not a failed check or a wrong agent action; say which layer stopped it.
  const cause =
    code !== 'permission_denied'
      ? undefined
      : /user denied/i.test(detail)
        ? 'approval-denied'
        : /no approval handler/i.test(detail)
          ? 'approval-unavailable'
          : /task contract|does not permit|only permits|belongs to (?:another|a different)/i.test(
                detail
              )
            ? 'task-authority'
            : 'tool-policy'
  return {
    code,
    retryable:
      code === 'precondition_failed' ||
      (effect === 'read' && !['permission_denied', 'invalid_arguments'].includes(code)),
    ...(cause ? { cause } : {})
  }
}

const PARALLEL_READ_TOOLS = new Set([
  'web_search',
  'web_open',
  'grep',
  'semantic_search',
  'retrieve',
  'git_status',
  'git_diff'
])

async function executeParallelReadTool(
  workspacePath: string | null,
  originalGoal: string,
  call: ToolCall,
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  try {
    switch (call.name) {
      case 'web_search':
        return {
          ok: true,
          detail: await searchWeb(argString(call.args, 'query'), signal),
          mutated: false
        }
      case 'web_open': {
        const url = argString(call.args, 'url')
        return { ok: true, detail: await openWebPage(url, signal), mutated: false, path: url }
      }
      case 'grep': {
        if (!workspacePath) return { ok: false, detail: 'No workspace is open', mutated: false }
        const query = argString(call.args, 'pattern') || argString(call.args, 'query')
        const result = await workspaceGrep(workspacePath, query, {
          glob: argString(call.args, 'glob') || undefined
        })
        return { ok: result.ok, detail: result.detail, mutated: false }
      }
      case 'semantic_search':
      case 'retrieve': {
        if (!workspacePath) return { ok: false, detail: 'No workspace is open', mutated: false }
        const query =
          argString(call.args, 'query') || argString(call.args, 'pattern') || originalGoal
        const result = await inspectWorkspace(workspacePath, query, 8)
        return { ok: result.ok, detail: result.detail, mutated: false }
      }
      case 'git_status': {
        if (!workspacePath) return { ok: false, detail: 'No workspace is open', mutated: false }
        const status = await gitStatus(workspacePath)
        if (!status.ok)
          return { ok: false, detail: status.error || 'git status failed', mutated: false }
        const lines = [
          `branch ${status.branch || '?'} ↑${status.ahead} ↓${status.behind}`,
          ...status.entries.map((entry) => `${entry.status} ${entry.path}`)
        ]
        return { ok: true, detail: lines.join('\n') || 'clean', mutated: false }
      }
      case 'git_diff': {
        if (!workspacePath) return { ok: false, detail: 'No workspace is open', mutated: false }
        const path = argString(call.args, 'path') || undefined
        const diff = await gitDiff(workspacePath, path)
        return {
          ok: diff.ok,
          detail: diff.ok ? diff.diff : diff.error || 'git diff failed',
          mutated: false,
          path
        }
      }
      default:
        return {
          ok: false,
          detail: `Tool is not eligible for parallel reads: ${call.name}`,
          mutated: false
        }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      mutated: false,
      path: argString(call.args, 'path') || undefined
    }
  }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        out[index] = await run(items[index]!, index)
      }
    })
  )
  return out
}

export async function* runAgentWithWorkspaceTools(options: {
  workspacePath: string | null
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** ask = answer only; agent = may call tools per TurnPlan */
  mode?: AgentMode
  /** Precomputed plan; recomputed in main if omitted. */
  turnPlan?: TurnPlan
  /** Resolves false when the user denies a shell command / push. Absent = always allow. */
  approveCommand?: (kind: 'run' | 'push', command: string) => Promise<boolean>
  /** Every MCP call requires approval for its exact tool name and arguments. */
  approveMcpTool?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  /**
   * Ask the user a clarifying question inline (up to five minutes). Absent = proceed with best judgment.
   * Returns reply text, or null when timed out / skipped.
   */
  askUser?: (question: string, choices?: string[]) => Promise<string | null>
  /**
   * sync = (re)start MCP servers for this workspace; reuse = use already-running servers;
   * off = no MCP tools (evals, so runs stay reproducible).
   */
  mcp?: 'sync' | 'reuse' | 'off'
  /** Background job id when running as a worktree agent (enables await_children). */
  jobId?: string | null
  /** Spawn a specialist child (orchestrator delegate_to_agent). */
  onDelegate?: (request: {
    agentId: string
    goal: string
    summary: string
    files?: string[]
    openQuestions?: string[]
    confidence?: number
    claim?: string
    wait?: boolean
    handoff: AgentHandoffPacket
  }) => Promise<{ ok: boolean; childJobId?: string; detail: string }>
  /** Wait for children of the current job. */
  onAwaitChildren?: (timeoutMs: number) => Promise<{ ok: boolean; detail: string }>
  /**
   * Chat turns run a specialist in this same workspace and model.
   * Nested specialists set this false so they cannot delegate again.
   */
  allowDelegate?: boolean
}): AsyncGenerator<AgentRunnerEvent, void, unknown> {
  const messages: AgentChatMessage[] = options.messages.map((m) => ({ ...m }))
  const mode: AgentMode = options.mode === 'ask' ? 'ask' : 'agent'
  const originalUserGoal =
    options.turnPlan?.task?.originalText ??
    ([...messages]
      .reverse()
      .find((m) => m.role === 'user')
      ?.content.replace(/\n\n\[Eris\][\s\S]*$/, '') ||
      '')

  let plan =
    options.turnPlan ??
    (await planChatTurn({
      workspacePath: options.workspacePath,
      settings: options.settings,
      context: {
        text: originalUserGoal,
        selectedModel: options.model,
        mode,
        manualAgentId: null
      },
      getSecret: options.getSecret,
      signal: options.signal
    }))
  const task =
    options.turnPlan?.task ??
    createTaskContract({
      workspacePath: options.workspacePath,
      text: originalUserGoal,
      plan,
      history: messages.slice(0, -1)
    })
  plan = { ...plan, task, toolPolicy: intersectToolPolicy(plan.toolPolicy, task) }
  const gateway = new TaskToolGateway(task)
  const executionRoot = task.scope.projectRoot ?? options.workspacePath
  const workflow = new AgentWorkflow(plan, originalUserGoal)

  yield { type: 'status', text: plan.reason }
  if (plan.error) {
    logWarn('Agent blocked before inference', { taskId: task.taskId, reason: 'route-error' })
    yield { type: 'progress', step: 0, actionLog: [], filesTouched: [], incomplete: true }
    yield { type: 'answer', text: plan.error, replace: true }
    return
  }

  // Specialist outcomes, so the final answer never presents failed, cancelled or
  // unsupported child work as finished.
  const delegationOutcomes: Array<{
    agentId: string
    goal: string
    status: 'done' | 'unverified' | 'failed' | 'cancelled'
  }> = []
  function recordDelegation(
    agentId: string,
    goal: string,
    status: (typeof delegationOutcomes)[number]['status'],
    child: TaskContract | undefined
  ) {
    delegationOutcomes.push({ agentId, goal, status })
    appendTaskEvent(task.taskId, 'delegation', {
      agentId,
      status,
      childTaskId: child?.taskId ?? null,
      childProject: child?.scope.projectRoot ?? null,
      childAuthority: child?.authority ?? null
    })
  }
  function unresolvedDelegationNote(): string {
    const open = delegationOutcomes.filter((item) => item.status !== 'done')
    if (!open.length) return ''
    const label = {
      unverified: 'returned claims without tool evidence',
      failed: 'did not finish',
      cancelled: 'was cancelled',
      done: ''
    }
    return `Specialist results not confirmed:\n${open
      .map((item) => `- ${item.agentId} ${label[item.status]}: ${item.goal.slice(0, 160)}`)
      .join('\n')}`
  }

  function applyWorkflowLint(branch: string, can: Parameters<typeof lintExecutionPlan>[1]) {
    const linted = lintExecutionPlan(plan.executionPlan, can)
    if (linted.conflicts.length === 0) return
    appendTaskEvent(task.taskId, 'workflow-lint', { branch, conflicts: linted.conflicts })
    logInfo('Adjusted infeasible workflow steps', {
      taskId: task.taskId,
      branch,
      conflicts: linted.conflicts.map((conflict) => `${conflict.needs}:${conflict.layer}`)
    })
    plan = { ...plan, executionPlan: linted.executionPlan }
  }

  const contractConflicts = taskContractConflicts(task)
  if (contractConflicts.length > 0) {
    logWarn('Agent blocked before inference', {
      taskId: task.taskId,
      reason: 'contract-conflict',
      conflicts: contractConflicts
    })
    yield { type: 'progress', step: 0, actionLog: [], filesTouched: [], incomplete: true }
    yield {
      type: 'answer',
      text: `This request's task contract is internally inconsistent, so no model was called: ${contractConflicts.join(' ')}`,
      replace: true
    }
    return
  }

  if (options.workspacePath && task.scope.state !== 'resolved') {
    logWarn('Agent blocked before inference', {
      taskId: task.taskId,
      reason: 'project-scope',
      scopeState: task.scope.state
    })
    yield { type: 'progress', step: 0, actionLog: [], filesTouched: [], incomplete: true }
    yield {
      type: 'answer',
      text: `I couldn't identify the requested project unambiguously in the open workspace. Available projects: ${task.scope.candidates.join(', ') || '(none)'}. Select the intended project folder so I can work on the right code.`,
      replace: true
    }
    return
  }
  const chatModel = plan.models.chat
  let workerModel = plan.models.tools
  const modelsCatalog =
    plan.intent === 'capability' ? formatAvailableModelsPrompt(options.settings, chatModel) : ''
  // Safety net: "review/improve the project folder" must never go answer-only just
  // because a weak router labeled the turn as answer.
  const forceWorkspaceTools =
    Boolean(options.workspacePath) &&
    mode === 'agent' &&
    plan.intent !== 'capability' &&
    (/\b(improv(e|es|ed|ing|ement|ements)|polish|enhance|refactor)\b/i.test(originalUserGoal) ||
      (/\breview\b/i.test(originalUserGoal) &&
        /\b(project|folder|codebase|workspace|repo|app|code|calculator)\b/i.test(
          originalUserGoal
        )) ||
      // "how do I launch / make it work / build the .app" must inspect the workspace
      /\b(launch|run|start|open|build)\b[\s\S]{0,40}\b(app|application|\.app|xcode|scheme|project)\b/i.test(
        originalUserGoal
      ) ||
      /\bmake\b[\s\S]{0,32}\b(it\s+)?(so\s+it\s+)?works?\b/i.test(originalUserGoal) ||
      /\b(get|make)\b[\s\S]{0,24}\b(it|this|the app)\b[\s\S]{0,24}\bwork/i.test(originalUserGoal))
  const webQuestion = needsWebLookup(originalUserGoal)
  const answerOnly =
    !workflow.contract.requiresMutation &&
    (plan.intent === 'capability' ||
      (!webQuestion &&
        !forceWorkspaceTools &&
        (!plan.requiresTools ||
          plan.toolPolicy === 'none' ||
          !options.workspacePath ||
          plan.intent === 'answer')))

  if (answerOnly) {
    workflow.transition('answering')
    // A tool-free reply cannot follow steps that read, edit or run.
    applyWorkflowLint('answer-only', {
      tools: false,
      read: false,
      edit: false,
      run: false,
      editAuthority: task.authority.edit
    })
    yield {
      type: 'model',
      model: chatModel,
      agentId: plan.agentId,
      agentName: plan.agentName
    }
    yield {
      type: 'status',
      text:
        plan.intent === 'capability'
          ? 'Answering from model catalog…'
          : mode === 'ask'
            ? `Ask · ${plan.agentName}…`
            : `${plan.agentName}…`
    }
    const tips: string[] = [...(modelsCatalog ? [modelsCatalog] : [])]
    if (plan.intent !== 'capability')
      tips.push(artifactResponseContract(interpretationOf(task), task.scope.applicability))
    if (plan.executionPlan) {
      tips.push(
        `Task plan:\n${plan.executionPlan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\nDone when: ${plan.executionPlan.doneWhen}`
      )
    }
    if (mode === 'ask') {
      tips.push(
        'You are in Ask mode. Answer clearly in markdown with concrete paths/symbols when relevant. ' +
          'Do not edit files or call workspace tools. If the user needs changes, say they should switch to Agent mode.'
      )
    }
    if (plan.intent === 'capability' || isErisCapabilityQuestion(originalUserGoal)) {
      tips.push(
        'The user asked about Eris AI models/providers. Answer ONLY from the [Eris AI models] catalog above. ' +
          'Do not retrieve, tree, or search the workspace for “models”.'
      )
    }
    // Answer-only turns compile the same task contract as tool workers, with a
    // tool-free protocol, so task identity and permissions agree across branches.
    const priorSystem = messages.find((m) => m.role === 'system')?.content || ''
    const compiled = compileTaskContext({
      task,
      toolsAvailable: false,
      guidance: tips.join('\n\n'),
      project: priorSystem,
      retrieval: '',
      maxInputTokens: contextBudgetTokens(options.settings, chatModel)
    })
    appendTaskEvent(task.taskId, 'context-compiled', {
      revision: task.revision,
      agentId: plan.agentId,
      model: chatModel,
      blocks: compiled.blocks,
      budget: compiled.budget
    })
    const askMessages = [
      compiled.message,
      ...messages.filter((m) => m.role !== 'system').map((m) => ({ ...m }))
    ]
    const askSessionKey =
      isNativeGgufRef(chatModel) && options.jobId ? `gguf:${options.jobId}` : undefined
    let full = ''
    try {
      for await (const evt of streamThinkingText({
        ...options,
        model: chatModel,
        messages: askMessages,
        sessionKey: askSessionKey
      })) {
        if (evt.kind === 'thinking') {
          if (evt.text) yield { type: 'answer', text: evt.text }
        } else full = evt.full
      }
    } finally {
      if (askSessionKey) releaseLocalChatSession(askSessionKey)
    }
    const answer = stripToolBlocks(full) || full
    if (answer) yield { type: 'answer', text: answer, replace: true }
    workflow.complete()
    return
  }

  if (workflow.contract.requiresMutation && !options.workspacePath) {
    const reason = 'Open a project folder before asking the agent to change code.'
    workflow.block(reason)
    yield { type: 'status', text: 'Blocked · no workspace' }
    yield { type: 'answer', text: reason, replace: true }
    return
  }

  const workspacePath = options.workspacePath as string
  const mcpMode = options.mcp ?? 'sync'
  /** Local GGUF KV session for this chat run (multi-step reuse). */
  const ggufSessionKey =
    options.jobId && isNativeGgufRef(workerModel) ? `gguf:${options.jobId}` : undefined
  const releaseGgufSession = () => {
    if (ggufSessionKey) releaseLocalChatSession(ggufSessionKey)
  }

  // Paint status immediately — don't wait on MCP sync / workspace retrieval.
  workflow.transition('preflight')
  yield {
    type: 'status',
    text: `${plan.agentName} · ${plan.intent} · ${workerModel.replace(/^builtin:/, '')}…`
  }
  yield {
    type: 'model',
    model: workerModel,
    agentId: plan.agentId,
    agentName: plan.agentName
  }
  if (plan.escalateToFull) {
    yield {
      type: 'thinking',
      text: `\n\n— Escalating tools to Composer Full (chat stays on ${chatModel.replace(/^builtin:/, '')})…\n`
    }
    yield {
      type: 'adapt',
      kind: 'escalate',
      reason: plan.reason,
      model: workerModel,
      agentId: plan.agentId,
      agentName: plan.agentName
    }
  }

  const preflightStartedAt = Date.now()
  let mcpSyncMs = 0
  let retrievalMs = 0
  const mcpSyncStartedAt = Date.now()
  const mcpSyncP =
    mcpMode === 'sync'
      ? syncMcpRuntime(options.settings, workspacePath)
          .catch(() => undefined)
          .finally(() => {
            mcpSyncMs = Date.now() - mcpSyncStartedAt
          })
      : Promise.resolve()
  const retrievalStartedAt = Date.now()
  // A generic request gets no retrieved leads: unrelated project files are not evidence.
  const retrievalSkipped =
    plan.intent === 'run'
      ? 'run-intent'
      : task.scope.projectRoot !== task.scope.workspaceRoot
        ? 'nested-project'
        : task.scope.applicability === 'generic'
          ? 'generic-request'
          : null
  const retrieveP = retrievalSkipped
    ? Promise.resolve(null)
    : inspectWorkspace(workspacePath, originalUserGoal, 6)
        .catch(() => null)
        .finally(() => {
          retrievalMs = Date.now() - retrievalStartedAt
        })

  const checkpoint = createCheckpoint(workspacePath)
  pruneOldCheckpoints(workspacePath, 20)
  yield { type: 'checkpoint', checkpointId: checkpoint.id }

  const [, retrieved] = await Promise.all([mcpSyncP, retrieveP])
  appendTaskEvent(task.taskId, 'retrieval', {
    query: originalUserGoal.slice(0, 2000),
    skipped: retrievalSkipped,
    applicability: task.scope.applicability ?? null,
    results: (retrieved?.reasons ?? []).map((item) => ({ path: item.path, signals: item.signals })),
    detailChars: retrieved?.detail.length ?? 0
  })
  workflow.transition('executing')
  logInfo('Agent preflight timings', {
    intent: plan.intent,
    mcpMode,
    mcpSyncMs,
    retrievalMs,
    totalMs: Date.now() - preflightStartedAt,
    retrievedFiles: retrieved?.paths.length ?? 0
  })
  const mcpTools = mcpMode === 'off' ? [] : listMcpTools()

  let retrievalHint = ''
  if (retrieved && retrieved.paths.length > 0) {
    retrievalHint = `\n\n[Eris retrieval — ranked relevant files and snippets]\n${retrieved.detail.slice(0, AGENT_HANDOFF_CHARS)}`
  }
  const mcpToolCount = mcpTools.length
  const mcpToolDefinitions = mcpToolsToOpenAI(mcpTools)
  const mcpReadOnlyTools = new Set(
    mcpTools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.fqName)
  )
  const discoveredBuiltinToolNames = new Set<string>()
  const discoveredMcpToolNames = new Set<string>()
  // Reviewer and Verification, and edit tasks whose contract grants verification,
  // see a run tool limited to test/typecheck/lint commands by the gateway.
  const verificationRunAllowed = (): boolean =>
    mode !== 'ask' &&
    (plan.agentId === 'reviewer' ||
      plan.agentId === 'verifier' ||
      (task.authority.edit && task.authority.execute === 'verification'))
  // Role policy, feature settings, MCP catalog and discovery resolve to one record.
  const toolCapabilities = () =>
    resolveToolCapabilities({
      allowedByPolicy: (name) => toolAllowedByPolicy(name, plan.toolPolicy, false),
      toolPolicy: plan.toolPolicy,
      imagesEnabled: Boolean(options.settings.images?.enabled),
      mcpToolCount,
      verificationRun: verificationRunAllowed(),
      discovered: discoveredBuiltinToolNames,
      deferWeb: !webQuestion
    })
  const visibleComposerToolDefinitions = (): OpenAIToolDef[] => {
    const visible = new Set(
      toolCapabilities()
        .filter(isVisibleCapability)
        .map((capability) => capability.name)
    )
    return COMPOSER_OPENAI_TOOLS.filter((definition) => visible.has(definition.function.name))
  }
  const visibleMcpToolDefinitions = (): OpenAIToolDef[] =>
    mcpToolCount <= MAX_INLINE_MCP_TOOLS
      ? mcpToolDefinitions
      : mcpToolDefinitions.filter((definition) =>
          discoveredMcpToolNames.has(definition.function.name)
        )
  const visibleToolDefinitions = (): OpenAIToolDef[] => [
    ...visibleComposerToolDefinitions(),
    ...filterToolsByPolicy(visibleMcpToolDefinitions(), plan.toolPolicy, mcpReadOnlyTools)
  ]
  const openaiTools: OpenAIToolDef[] = visibleToolDefinitions()
  const recordToolManifest = (reason: string) =>
    appendTaskEvent(task.taskId, 'tool-manifest', {
      reason,
      agentId: plan.agentId,
      toolPolicy: plan.toolPolicy,
      tools: toolCapabilities(),
      mcp: { mode: mcpMode, count: mcpToolCount, inline: mcpToolCount <= MAX_INLINE_MCP_TOOLS },
      visible: openaiTools.map((tool) => tool.function.name),
      visibleSchemaChars: JSON.stringify(openaiTools).length
    })
  recordToolManifest('initial')
  {
    const visible = new Set(openaiTools.map((tool) => tool.function.name))
    applyWorkflowLint('worker', {
      tools: openaiTools.length > 0,
      read: ['read_file', 'grep', 'retrieve', 'tree'].some((name) => visible.has(name)),
      edit:
        task.authority.edit &&
        ['write_file', 'search_replace', 'apply_patch'].some((name) => visible.has(name)),
      run: visible.has('run'),
      editAuthority: task.authority.edit
    })
  }
  let promptBudget =
    contextBudgetTokens(options.settings, workerModel) -
    Math.ceil(JSON.stringify(openaiTools).length / 3) -
    128
  if (promptBudget < 512)
    throw new Error(
      'The available tools exceed this model context window. Increase context or reduce connected tools.'
    )
  const workerMessages: AgentChatMessage[] = buildPreservedWorkerMessages({
    messages,
    workspacePath,
    settings: options.settings,
    inputTokenBudget: promptBudget,
    plan: { ...plan, task },
    originalUserGoal,
    retrievalHint,
    mcpToolCount: plan.toolPolicy === 'read' || plan.toolPolicy === 'none' ? 0 : mcpToolCount
  })

  let lastTreeResult: string | null = null
  let lastInspectResult: string | null = null
  let workspaceMutated = false
  /** True only when product source (not .eris skills/rules/context) changed. */
  let codeMutated = false
  /** Cap inline clarifying prompts so a run cannot stall forever. */
  let askUserCount = 0
  const MAX_ASK_USER = 2
  const filesTouched: string[] = []
  const actionLog: string[] = []
  /** Rolling Lite-written memory folded across comped. */
  let contextMemory: string | null = null
  /** At most one dependency install per agent run. */
  let installAttempts = 0
  let noProgressStreak = 0
  let lastFingerprint = ''
  let repeatFingerprint = 0
  let duplicateToolBlocks = 0
  let toolExecRounds = 0
  let inspectRounds = 0
  let step = 0
  const maxStepsPerRun = options.settings.agent.maxStepsPerRun ?? 60
  let verifyFailures = 0

  const emitSessionStep = (summary?: string): AgentRunnerEvent => {
    const opThrough = getCheckpointOpCount(workspacePath, checkpoint.id)
    const last = summary || actionLog[actionLog.length - 1] || `Step ${step}`
    return {
      type: 'session-step',
      step,
      opThrough,
      summary: last.slice(0, 240),
      actionLog: [...actionLog],
      filesTouched: [...filesTouched],
      workerMessages: workerMessages.map((m) => ({ ...m }))
    }
  }
  let mutationsSinceVerify = 0
  let consecutiveToolErrors = 0
  let goalRejectCount = 0
  let verifyPassedOnce = false
  const escalateCount = plan.escalateToFull ? 1 : 0
  let rerouteCount = 0
  const reviewOnly =
    plan.intent === 'review' ||
    plan.intent === 'plan' ||
    plan.intent === 'verify' ||
    isReviewOnlyGoal(originalUserGoal)
  const listImprovements = asksForRecommendations(originalUserGoal)
  const describeProject = asksWhatTheProjectDoes(originalUserGoal)
  const webLookup = webQuestion
  let webSearchNudges = 0
  let webSearchText = ''
  let webPageText = ''
  const chatReply = describeProject || isReadOnlyChat(plan, mode)
  const describeProjectNext =
    `Read README, package.json, or the main source. Do not stop after .eris config. ` +
    `Do not write or edit files. ` +
    `Then reply with no tools: what this project is, what it does, and the important files, citing paths.`
  const chatReplyNext =
    plan.intent === 'plan'
      ? `Return an ordered implementation plan grounded in the files you read. Name relevant files or symbols, dependencies, risks, and a completion check for each step. State assumptions clearly. Do not edit files.`
      : listImprovements
        ? `Do not edit files. Read the project sources, then list the improvements as a numbered list and cite paths. Do not implement them.`
        : mode === 'ask'
          ? `Read the workspace sources needed to answer. Do not edit or run commands. Reply with concrete paths and evidence; if the request asks for changes, describe the change without applying it.`
          : `Do not edit files. Read the sources that answer the user, then reply in plain sentences and cite paths.`
  const answerNext = describeProject ? describeProjectNext : chatReply ? chatReplyNext : ''
  const sourceReads: Array<{ path: string; text: string }> = []
  const observedWorkspaceReads = new Map<string, Set<'file' | 'notebook'>>()
  const workspaceReadKey = (path: string): string | null => {
    try {
      const abs = resolveInWorkspace(workspacePath, path)
      try {
        return realpathSync(abs)
      } catch {
        return abs
      }
    } catch {
      return null
    }
  }
  const recordWorkspaceRead = (path: string, kind: 'file' | 'notebook'): void => {
    const key = workspaceReadKey(path)
    if (!key) return
    const kinds = observedWorkspaceReads.get(key) ?? new Set<'file' | 'notebook'>()
    kinds.add(kind)
    observedWorkspaceReads.set(key, kinds)
  }
  const forgetWorkspaceRead = (path: string | undefined): void => {
    if (!path) return
    const key = workspaceReadKey(path)
    if (key) observedWorkspaceReads.delete(key)
  }
  const missingReadPrecondition = (
    call: ToolCall,
    requirement: 'file' | 'notebook'
  ): { path: string; detail: string } | null => {
    let targetPath = argString(call.args, 'path')
    if (call.name === 'apply_patch') {
      try {
        targetPath = unifiedPatchTargetPath(
          argString(call.args, 'patch') || argString(call.args, 'diff')
        )
      } catch {
        return null // Let the patch tool report malformed patch input.
      }
    }
    if (!targetPath) return null
    try {
      const abs = resolveInWorkspace(workspacePath, targetPath)
      if (!existsSync(abs) || statSync(abs).isDirectory()) return null
      const key = workspaceReadKey(targetPath)
      if (key && observedWorkspaceReads.get(key)?.has(requirement)) return null
      const relativePath = toWorkspaceRelative(workspacePath, abs)
      const readTool = requirement === 'notebook' ? 'notebook_read' : 'read_file'
      return {
        path: relativePath,
        detail: `Read required before editing: ${relativePath} is an existing file. Call ${readTool} on this path, inspect its contents, then retry the edit.`
      }
    } catch {
      return null // Preserve the workspace tool's own path and permission errors.
    }
  }

  const productFilesAreTinyStubs = (): boolean => {
    const product = [...new Set(filesTouched)].filter((p) => pathNeedsProjectVerify(p))
    if (product.length === 0) return false
    let seen = 0
    for (const rel of product.slice(-12)) {
      try {
        const abs = resolveInWorkspace(workspacePath, rel)
        if (!existsSync(abs) || statSync(abs).isDirectory()) continue
        seen++
        if (statSync(abs).size >= STUB_FILE_MAX_BYTES) return false
      } catch {
        /* ignore */
      }
    }
    return seen > 0
  }
  // #4 grammar-constrained local tool calls: when a retry needs a tool and the
  // worker is the built-in GGUF model, force valid tool-call JSON via a grammar.
  const localConstrainEnabled = options.settings.agent.constrainLocalToolCalls !== false
  let constrainNextToolCall = false

  // Discovery changes the next request's schemas; record what was added and its size.
  // The prompt budget is recomputed from openaiTools before every compaction check.
  function recordToolDiscovery(
    via: string,
    query: string,
    added: Array<{ name: string; kind: string; schemaChars: number }>
  ) {
    appendTaskEvent(task.taskId, 'tools-discovered', {
      step,
      via,
      query,
      added,
      visibleSchemaChars: JSON.stringify(openaiTools).length
    })
  }

  function discoverMcpTools(query: string): string {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [])]
    if (terms.length === 0) return 'Describe an MCP integration or capability to search for.'
    const ranked = mcpTools
      .map((tool) => {
        const name = `${tool.name} ${tool.fqName}`.toLowerCase()
        const description = tool.description.toLowerCase()
        const combined = `${name} ${description}`
        const score =
          (combined.includes(query.toLowerCase()) ? 6 : 0) +
          terms.reduce(
            (total, term) =>
              total + (name.includes(term) ? 3 : 0) + (description.includes(term) ? 1 : 0),
            0
          )
        return { tool, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    if (ranked.length === 0) return `No connected MCP tools matched “${query}”.`

    const eligibleDefinitions = new Map(
      filterToolsByPolicy(mcpToolDefinitions, plan.toolPolicy, mcpReadOnlyTools).map(
        (definition) => [definition.function.name, definition]
      )
    )
    const added: Array<{ name: string; kind: string; schemaChars: number }> = []
    for (const { tool } of ranked) {
      discoveredMcpToolNames.add(tool.fqName)
      const definition = eligibleDefinitions.get(tool.fqName)
      if (definition && !openaiTools.some((item) => item.function.name === tool.fqName)) {
        openaiTools.push(definition)
        added.push({
          name: tool.fqName,
          kind: 'MCP',
          schemaChars: JSON.stringify(definition).length
        })
      }
    }
    recordToolDiscovery('search_mcp_tools', query, added)
    return [
      `Found ${ranked.length} MCP tool(s). They are now available for the next step:`,
      ...ranked.map(({ tool }) => `- ${tool.fqName} — ${tool.description || tool.name}`)
    ].join('\n')
  }

  function discoverTools(query: string): string {
    const normalizedQuery = query.trim().toLowerCase()
    const terms = [...new Set(normalizedQuery.match(/[a-z0-9_-]{2,}/g) || [])]
    if (terms.length === 0) return 'Describe the tool capability or workflow you need.'
    const scoreTool = (name: string, description: string): number => {
      const normalizedName = name.toLowerCase()
      const normalizedDescription = description.toLowerCase()
      const combined = `${normalizedName} ${normalizedDescription}`
      return (
        (combined.includes(normalizedQuery) ? 6 : 0) +
        terms.reduce(
          (score, term) =>
            score +
            (normalizedName.includes(term) ? 3 : 0) +
            (normalizedDescription.includes(term) ? 1 : 0),
          0
        )
      )
    }

    const builtinDefinitions = filterToolsByPolicy(
      COMPOSER_OPENAI_TOOLS,
      plan.toolPolicy,
      mcpReadOnlyTools
    )
    const builtinByName = new Map(
      builtinDefinitions.map((definition) => [definition.function.name, definition])
    )
    const mcpDefinitions = filterToolsByPolicy(
      mcpToolDefinitions,
      plan.toolPolicy,
      mcpReadOnlyTools
    )
    const mcpByName = new Map(
      mcpDefinitions.map((definition) => [definition.function.name, definition])
    )
    const deferred = new Set(
      toolCapabilities()
        .filter((capability) => capability.status === 'deferred')
        .map((capability) => capability.name)
    )
    const ranked = [
      ...COMPOSER_OPENAI_TOOLS.filter(
        (definition) =>
          deferred.has(definition.function.name) &&
          definition.function.name !== 'search_tools' &&
          builtinByName.has(definition.function.name)
      ).map((definition) => ({
        name: definition.function.name,
        description: definition.function.description,
        definition: builtinByName.get(definition.function.name)!,
        kind: 'built-in' as const,
        score: scoreTool(definition.function.name, definition.function.description)
      })),
      ...mcpTools
        .filter((tool) => mcpByName.has(tool.fqName))
        .map((tool) => ({
          name: tool.fqName,
          description: tool.description || tool.name,
          definition: mcpByName.get(tool.fqName)!,
          kind: 'MCP' as const,
          score: scoreTool(`${tool.name} ${tool.fqName}`, tool.description)
        }))
    ]
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)

    if (ranked.length === 0) return `No available tools matched “${query}”.`
    const added: Array<{ name: string; kind: string; schemaChars: number }> = []
    for (const candidate of ranked) {
      if (candidate.kind === 'built-in') discoveredBuiltinToolNames.add(candidate.name)
      else discoveredMcpToolNames.add(candidate.name)
      if (!openaiTools.some((item) => item.function.name === candidate.name)) {
        openaiTools.push(candidate.definition)
        added.push({
          name: candidate.name,
          kind: candidate.kind,
          schemaChars: JSON.stringify(candidate.definition).length
        })
      }
    }
    recordToolDiscovery('search_tools', query, added)
    return [
      `Found ${ranked.length} tool(s). They are available on the next step:`,
      ...ranked.map(
        ({ kind, name, description }) => `- ${kind} ${name} — ${description.slice(0, 240)}`
      )
    ].join('\n')
  }

  function* recordSkippedToolCalls(
    calls: ToolCall[],
    assistantText: string,
    detail: string
  ): Generator<AgentRunnerEvent, void, unknown> {
    // A rejected request is still a complete tool exchange. In particular,
    // native providers must receive a result for every assistant call ID.
    workerMessages.push({
      role: 'assistant',
      content: thinkingBeforeTools(assistantText),
      tool_calls: calls.map((call) => ({
        id: call.id!,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: call.parseError ? call.raw : JSON.stringify(call.args)
        }
      }))
    })
    for (const call of calls) {
      workerMessages.push({
        role: 'tool',
        tool_call_id: call.id!,
        content: `TOOL_RESULT ${call.name}: NOT_EXECUTED\n${detail}`
      })
      yield {
        type: 'tool',
        tool: {
          id: call.id!,
          name: call.name,
          path: typeof call.args.path === 'string' ? call.args.path : undefined,
          status: 'error',
          changedResources: [],
          failure: { code: 'NO_PROGRESS', retryable: true },
          detail
        }
      }
    }
    logInfo('Agent tool request skipped', {
      taskId: task.taskId,
      step,
      agentId: plan.agentId,
      model: workerModel,
      tools: calls.map((call) => call.name),
      fingerprint: toolFingerprint(calls)
    })
  }

  async function* tryMidRunAdapt(
    trigger: string
  ): AsyncGenerator<AgentRunnerEvent, boolean, unknown> {
    if (
      !shouldConsiderMidRunAdapt({
        verifyFailures,
        consecutiveToolErrors,
        noProgressStreak,
        escalateCount,
        rerouteCount
      })
    ) {
      return false
    }
    // A recovery route is a new turn plan and may widen tool access. Keep Ask
    // mode on the current read-only plan even when the worker is stuck.
    const decision =
      mode === 'ask'
        ? { kind: null, reason: '' as const }
        : await decideMidRunAdapt({
            workspacePath,
            settings: options.settings,
            plan,
            selectedModel: workerModel,
            goal: originalUserGoal,
            getSecret: options.getSecret,
            signal: options.signal,
            escalateCount,
            rerouteCount,
            actionLog,
            filesTouched
          })
    if ('refused' in decision && decision.refused)
      appendTaskEvent(task.taskId, 'reroute-refused', {
        reason: decision.refused,
        trigger,
        agentId: plan.agentId
      })
    if (decision.kind === 'reroute' && decision.nextPlan) {
      const fromAgent = plan.agentId
      plan = {
        ...decision.nextPlan,
        task,
        intent: task.intent,
        toolPolicy: intersectToolPolicy(decision.nextPlan.toolPolicy, task)
      }
      workerModel = plan.models.tools
      rerouteCount++
      // The worker changes; the task, its artifact, project and authority do not.
      appendTaskEvent(task.taskId, 'reroute', {
        from: fromAgent,
        to: plan.agentId,
        trigger,
        budget: { used: escalateCount + rerouteCount, max: MID_RUN_ADAPT_BUDGET },
        taskId: task.taskId,
        intent: task.intent,
        artifact: interpretationOf(task).artifact,
        project: task.scope.projectRoot,
        recommendationIds: task.recommendations.map((item) => item.id),
        authority: task.authority,
        toolPolicy: plan.toolPolicy
      })
      openaiTools.splice(0, openaiTools.length, ...visibleToolDefinitions())
      recordToolManifest('reroute')
      const reason = `${decision.reason} after ${trigger}`
      // Install the new agent's actual instructions, not just its display name.
      // Retain execution evidence and the original task's authority ceiling.
      const recoveryMessages = buildPreservedWorkerMessages({
        messages,
        workspacePath,
        settings: options.settings,
        inputTokenBudget: promptBudget,
        plan: { ...plan, task },
        originalUserGoal,
        retrievalHint,
        mcpToolCount: plan.toolPolicy === 'read' || plan.toolPolicy === 'none' ? 0 : mcpToolCount
      })
      if (recoveryMessages[0]?.role === 'system') {
        if (workerMessages[0]?.role === 'system') workerMessages[0] = recoveryMessages[0]
        else workerMessages.unshift(recoveryMessages[0])
      }
      releaseGgufSession()
      lastFingerprint = ''
      repeatFingerprint = 0
      consecutiveToolErrors = 0
      noProgressStreak = 0
      verifyFailures = Math.max(0, verifyFailures - 1)
      if (workerMessages[0]?.role === 'system') {
        workerMessages[0].content += `\n\nRECOVERY ROUTE: ${reason}. Resume from the existing action log and file changes; do not repeat completed work.`
      }
      workerMessages.push({
        role: 'system',
        content: `[Eris recovery] ${reason}. Continue the original goal. Existing work and failures: ${actionLog.slice(-8).join(' · ')}`
      })
      yield {
        type: 'adapt',
        kind: 'reroute',
        reason,
        agentId: plan.agentId,
        agentName: plan.agentName,
        model: workerModel
      }
      yield { type: 'status', text: `${reason} · continuing` }
      yield { type: 'thinking', text: `\n\n— ${reason}; continuing with the saved progress…\n` }
      return true
    }

    // Keep the current role when no safe fallback is configured, but give it a concrete recovery instruction.
    rerouteCount++
    const reason =
      mode === 'ask'
        ? `Ask mode stays read-only while ${plan.agentName} recovers. ${trigger}.`
        : `${plan.agentName} is correcting the failed tool request using the current task context.`
    consecutiveToolErrors = 0
    noProgressStreak = 0
    verifyFailures = Math.max(0, verifyFailures - 1)
    constrainNextToolCall = true
    yield { type: 'status', text: reason }
    yield { type: 'thinking', text: `\n\n— ${reason}\n` }
    workerMessages.push({
      role: 'system',
      content:
        `[Eris] ${reason}\n` +
        `Recent actions and failures: ${actionLog.slice(-8).join(' · ')}\n` +
        `Diagnose the failure category. Use a different tool or smaller step, preserve completed changes, and verify the next result before continuing.`
    })
    return true
  }

  async function* compactWorkerContext(
    opts: {
      force?: boolean
      skipLiteSummary?: boolean
    } = {}
  ): AsyncGenerator<AgentRunnerEvent, void, unknown> {
    promptBudget =
      contextBudgetTokens(options.settings, workerModel) -
      Math.ceil(JSON.stringify(openaiTools).length / 3) -
      128
    const force = Boolean(opts.force)
    if (!needsContextCompaction(workerMessages, promptBudget, force)) return

    const micro = microCompactAgentMessages(workerMessages, promptBudget)
    if (micro.changed) {
      workerMessages.splice(0, workerMessages.length, ...micro.messages)
      yield {
        type: 'thinking',
        text: '\n\n— Shortened older tool output locally to free context…\n'
      }
      // The transcript changed even when no model summary was needed.
      releaseGgufSession()
      if (micro.withinBudget && !force) return
    }
    // Never swap Lite↔Full mid-run — node-llama-cpp holds one runtime; unloading
    // Full to summarize with Lite freezes the app for minutes and looks "broken".
    // Stay on the tools model for compaction — never unload Full mid-run.
    const canSummarizeInline = chatModel === workerModel
    const skipLite = Boolean(opts.skipLiteSummary) || !canSummarizeInline
    yield { type: 'status', text: 'Compacting context…' }
    yield {
      type: 'thinking',
      text: skipLite
        ? '\n\n— Compacting context from action log…\n'
        : '\n\n— Summarizing context so work can continue…\n'
    }
    const compacted = await compactAgentMessages({
      messages: workerMessages,
      goal: originalUserGoal,
      filesTouched,
      actionLog,
      treeSnapshot: lastTreeResult,
      priorMemory: contextMemory,
      settings: options.settings,
      liteModel: workerModel,
      temperature: options.temperature,
      signal: options.signal,
      getSecret: options.getSecret,
      skipLiteSummary: skipLite
    })
    workerMessages.length = 0
    workerMessages.push(...compacted.messages)
    contextMemory = compacted.memory || contextMemory
    // History rewritten — drop KV session so the next turn re-seeds.
    releaseGgufSession()
  }

  const nudgeToTools = (reason: string): AgentChatMessage => ({
    role: 'system',
    content:
      `${reason}\n\n` +
      (lastTreeResult
        ? `The workspace listing is already in context — do NOT call tree/list_dir again.\n` +
          `Active user request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}\n\n` +
          (answerNext
            ? answerNext
            : reviewOnly
              ? `Next step: emit read_file on key sources and/or {"name":"run","command":"npm test"} (or typecheck). ` +
                `Then a DONE summary with blockers → risks → suggestions. Do not ask the user for files.`
              : `Next step: emit search_replace / write_file / mkdir / read_file tool JSON now. ` +
                `Keep tooling until the request is fully done, then a short DONE summary.`)
        : `Emit ONLY this tool call next:\n\n{"name":"tree","path":"."}\n\n` +
          `Then continue with retrieve/read_file` +
          (answerNext
            ? ` on the files that answer the user, then reply in plain sentences.`
            : `${reviewOnly ? '/run' : '/search_replace/write_file/run'} until the request is done.`) +
          ` Never ask the user for project structure.`)
  })

  const nudgeAfterInspect = (_snapshot: string): AgentChatMessage => ({
    role: 'system',
    content:
      `Do NOT call tree or list_dir again — you already have the listing above.\n` +
      `Active user request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}\n\n` +
      (answerNext
        ? answerNext
        : reviewOnly
          ? `Next: emit read_file on the important source files, optionally run tests/typecheck, ` +
            `then DONE summary (blockers → risks → suggestions → nits) with concrete paths.`
          : `Next: emit search_replace or write_file (and mkdir if needed), or read_file if you still need detail. ` +
            `Keep going until the full request is satisfied; only then a short DONE summary with no tools.`)
  })

  const nudgeContinueWork = (reason: string): AgentChatMessage => ({
    role: 'system',
    content:
      `${reason}\n\n` +
      `Active user request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}\n` +
      (filesTouched.length
        ? `Already touched: ${[...new Set(filesTouched)].join(', ')}\n`
        : answerNext
          ? 'No project source has been read yet — read the files that answer the user before replying.\n'
          : reviewOnly
            ? 'This is a review/improve-inspection phase — gather facts with tools before concluding.\n'
            : 'No files written yet — you still need to make progress with tools.\n') +
      (answerNext
        ? answerNext
        : reviewOnly
          ? `Emit read_file or run tool JSON, OR if you already have enough evidence, reply with a DONE review summary and no tools.`
          : `You are NOT finished. Emit the next search_replace / write_file / mkdir / read_file / run tool JSON now. ` +
            `When — and only when — the full request is satisfied, reply with a short DONE summary and no tools.`)
  })

  // Loop until done, abort, or hard budgets.
  const chatReadBudget = 4
  let latestAssistant = ''
  const webSearchNudge = (): AgentChatMessage => ({
    role: 'system',
    content:
      `This question is about the public web. Do not read workspace files and do not guess a biography.\n` +
      `Call web_search now:\n{"name":"web_search","query":${JSON.stringify(webSearchQuery(originalUserGoal))}}\n` +
      `Then stop.`
  })
  async function* answerFromWeb(): AsyncGenerator<AgentRunnerEvent, void, unknown> {
    const query = webSearchQuery(originalUserGoal) || originalUserGoal.slice(0, 200)
    if (!webSearchText) {
      yield { type: 'status', text: 'Searching the web…' }
      yield { type: 'thinking', text: `\n\n— Searching the web for “${query}”…\n` }
      const id = 'web_auto_search'
      yield { type: 'tool', tool: { id, name: 'web_search', status: 'running', detail: query } }
      try {
        webSearchText = await searchWeb(query, options.signal)
        actionLog.push(webSearchText.split('\n')[0]!.slice(0, 160))
        yield {
          type: 'tool',
          tool: {
            id,
            name: 'web_search',
            status: 'ok',
            detail: webSearchText.slice(0, AGENT_HANDOFF_CHARS)
          }
        }
        yield { type: 'thinking', text: '\n[ok] web_search\n' }
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'Web search failed'
        yield { type: 'tool', tool: { id, name: 'web_search', status: 'error', detail } }
        yield {
          type: 'answer',
          text: `I could not search the web for “${query}”. ${detail}`,
          replace: true
        }
        return
      }
    }
    if (httpsResults(webSearchText).length > 0) {
      const opened = new Set([...webPageText.matchAll(/^Opened (\S+)/gm)].map((match) => match[1]))
      for (const [index, url] of httpsResults(webSearchText).entries()) {
        if (opened.has(url)) continue
        yield { type: 'status', text: 'Opening search results…' }
        yield { type: 'thinking', text: `\n\n— Opening ${url}…\n` }
        const id = `web_auto_open_${index + 1}`
        yield {
          type: 'tool',
          tool: { id, name: 'web_open', path: url, status: 'running', detail: url }
        }
        try {
          const page = await openWebPage(url, options.signal)
          webPageText = [webPageText, page].filter(Boolean).join('\n\n')
          opened.add(url)
          actionLog.push(page.split('\n')[0]!.slice(0, 160))
          yield {
            type: 'tool',
            tool: {
              id,
              name: 'web_open',
              path: url,
              status: 'ok',
              detail: page.slice(0, AGENT_HANDOFF_CHARS)
            }
          }
          yield { type: 'thinking', text: `\n[ok] web_open ${url}\n` }
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Could not open the page'
          yield {
            type: 'tool',
            tool: { id, name: 'web_open', path: url, status: 'error', detail }
          }
          yield {
            type: 'thinking',
            text: '\n\n— Could not open the page; answering from the search results…\n'
          }
        }
      }
    }
    const evidence = [webSearchText, webPageText].filter(Boolean).join('\n\n')
    const noHits = !firstHttpsResult(webSearchText) && /No results\./.test(webSearchText)
    let modelText = ''
    if (!noHits) {
      yield { type: 'status', text: 'Answering from the page…' }
      yield { type: 'thinking', text: '\n\n— Answering from the web results…\n' }
      yield { type: 'answer', text: '', replace: true }
      try {
        for await (const evt of streamThinkingText({
          ...options,
          model: workerModel,
          messages: [
            {
              role: 'system',
              content:
                'Answer only from the sources in the user message. ' +
                'If they do not identify the subject, say you could not find a reliable public page. ' +
                'Do not add jobs, shows, awards, schools, or employers that are not written in the sources.'
            },
            {
              role: 'user',
              content:
                `Question:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}\n\nSources:\n${truncateForModel(evidence, AGENT_HANDOFF_CHARS)}\n\n` +
                'Write a short answer in plain sentences and cite the page URL.'
            }
          ],
          stopOnToolCall: false,
          tools: undefined,
          builtinJsonSchema: undefined,
          sessionKey: undefined
        })) {
          if (evt.kind === 'thinking') {
            if (evt.text) yield { type: 'answer', text: evt.text }
          } else modelText = evt.full
        }
      } catch {
        modelText = ''
      }
    }
    const answer = replyFromWebEvidence(modelText, query, webSearchText, webPageText)
    yield { type: 'status', text: 'Done' }
    yield { type: 'answer', text: answer, replace: true }
  }
  async function* finishChatAnswer(
    latest: string
  ): AsyncGenerator<AgentRunnerEvent, void, unknown> {
    const outcome = workflow.evaluateOutcome({
      workspaceMutated,
      codeMutated,
      verifyPassed: verifyPassedOnce
    })
    if (!outcome.ok) {
      workflow.block(outcome.reason!)
      yield {
        type: 'progress',
        step,
        actionLog: [...actionLog],
        filesTouched: [...filesTouched],
        incomplete: true
      }
      yield { type: 'status', text: 'Incomplete · insufficient evidence' }
      yield {
        type: 'answer',
        text: `I couldn't complete this request with verified project evidence. ${outcome.reason}`,
        replace: true
      }
      return
    }
    const existing = proseOutsideTools(latest)
    if (existing.length >= 40 && !isToolLogReply(existing)) {
      yield { type: 'status', text: 'Done' }
      yield { type: 'answer', text: existing, replace: true }
      return
    }
    const changed = [...new Set(filesTouched)].filter((file) => {
      const path = file.replace(/\\/g, '/').replace(/^\.\//, '')
      return path && !path.startsWith('.eris/')
    })
    workerMessages.push({
      role: 'system',
      content:
        `Thinking is finished. Write the reply the user will read. No tools and no JSON.\n` +
        (changed.length && !listImprovements
          ? `Review the changes. For each file, say what changed: ${changed.join(', ')}.\n`
          : listImprovements
            ? `List the improvements the user asked for. Number them. Cite file paths. Do not describe edits you made.\n`
            : `Answer the user's question in plain sentences.\n`) +
        `Do not write "Finished:" or "What I did:".\n\n` +
        `User asked:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}`
    })
    yield { type: 'answer', text: '', replace: true }
    let reply = ''
    for await (const evt of streamThinkingText({
      ...options,
      model: workerModel,
      messages: workerMessages,
      stopOnToolCall: false,
      tools: undefined,
      builtinJsonSchema: undefined,
      sessionKey: isNativeGgufRef(workerModel) ? ggufSessionKey : undefined
    })) {
      if (evt.kind === 'thinking') {
        if (evt.text) yield { type: 'answer', text: evt.text }
      } else reply = evt.full
    }
    const clean = proseOutsideTools(reply)
    const searched = actionLog.find((entry) => entry.startsWith('Searched the web'))
    const fallback = changed.length
      ? `Changed ${changed.slice(0, 8).join(', ')}.`
      : searched || answerFromProjectFiles(sourceReads)
    const answer = postedAnswer(reply, fallback) || clean || 'Done.'
    yield { type: 'status', text: 'Done' }
    yield { type: 'answer', text: answer, replace: true }
  }

  try {
    for (;;) {
      throwIfAborted(options.signal)

      if (step >= maxStepsPerRun) {
        const stopNote = `Stopped after ${maxStepsPerRun} steps. This run is incomplete; start a new request to continue with the saved workspace changes.`
        workflow.block(stopNote)
        actionLog.push(stopNote)
        yield {
          type: 'progress',
          step,
          actionLog: [...actionLog],
          filesTouched: [...filesTouched],
          incomplete: true
        }
        yield emitSessionStep(stopNote)
        yield { type: 'status', text: 'Paused · run step budget reached' }
        yield {
          type: 'answer',
          text: `${buildWorkSummary(originalUserGoal, actionLog, latestAssistant)}\n\n${stopNote}`,
          replace: true
        }
        return
      }

      for await (const evt of compactWorkerContext()) yield evt

      if (
        shouldConsiderMidRunAdapt({
          verifyFailures,
          consecutiveToolErrors,
          noProgressStreak,
          escalateCount,
          rerouteCount
        })
      ) {
        const adapted = yield* tryMidRunAdapt('stuck signals')
        if (adapted) continue
      }

      if (chatReply && toolExecRounds >= chatReadBudget) {
        if (webLookup) {
          yield* answerFromWeb()
          return
        }
        yield {
          type: 'thinking',
          text: '\n\n— Enough reading; answering the message…\n'
        }
        yield* finishChatAnswer(latestAssistant)
        return
      }

      step++
      yield {
        type: 'status',
        text: `${plan.agentName} · ${plan.intent} (step ${step})…`
      }

      let assistantText = ''
      let abortedLoop = false
      let nativeFromStream: ToolCall[] | undefined
      const constrainThisTurn =
        constrainNextToolCall &&
        localConstrainEnabled &&
        !reviewOnly &&
        !chatReply &&
        isNativeGgufRef(workerModel)
      constrainNextToolCall = false
      const visibleToolNamesThisStep = new Set(openaiTools.map((tool) => tool.function.name))
      for await (const evt of streamThinkingText({
        ...options,
        model: workerModel,
        messages: workerMessages,
        stopOnToolCall: true,
        tools: openaiTools,
        builtinJsonSchema: constrainThisTurn
          ? toolCallJsonSchema(
              mcpTools.map((tool) => tool.fqName),
              openaiTools.map((tool) => tool.function.name),
              true
            )
          : undefined,
        sessionKey: isNativeGgufRef(workerModel) ? ggufSessionKey : undefined
      })) {
        if (evt.kind === 'thinking') {
          // Model tokens are the reply, not the thinking trace.
        } else {
          assistantText = evt.full
          latestAssistant = evt.full
          abortedLoop = evt.aborted === 'loop'
          nativeFromStream = evt.nativeToolCalls
        }
      }
      throwIfAborted(options.signal)

      // Prefer native OpenAI tool_calls; fall back to text <<<TOOL>>> / JSON parsing.
      const toolCalls =
        nativeFromStream && nativeFromStream.length > 0
          ? nativeFromStream
          : parseToolCalls(assistantText)

      toolCalls.forEach((call, index) => {
        call.id ??= `${task.taskId}:${step}:${index}`
      })

      if (
        chatReply &&
        toolCalls.length > 0 &&
        toolCalls.every(
          (call) =>
            !toolAllowedByPolicy(call.name, 'read', mcpReadOnlyTools.has(call.name)) &&
            call.name !== 'run'
        )
      ) {
        const note = thinkingBeforeTools(assistantText).trim()
        if (note.length >= 40 || sourceReads.length > 0) {
          yield {
            type: 'thinking',
            text: '\n\n— This agent answers in chat and does not edit the project…\n'
          }
          yield* finishChatAnswer(assistantText)
          return
        }
        yield {
          type: 'thinking',
          text: '\n\n— This agent does not edit files. Read the project, then answer…\n'
        }
        workerMessages.push({ role: 'system', content: answerNext || chatReplyNext })
        continue
      }

      if (toolCalls.length === 0) {
        if (webLookup) {
          if (!webSearchText && webSearchNudges < 1) {
            webSearchNudges++
            yield {
              type: 'thinking',
              text: '\n\n— This needs a web search before an answer…\n'
            }
            workerMessages.push(webSearchNudge())
            continue
          }
          yield* answerFromWeb()
          return
        }
        // Local models often ask "please provide the project structure" instead of
        // calling tree — run tree ourselves and continue (don't stop or ask the user).
        if (looksLikeAsksForWorkspaceInfo(assistantText) && !lastTreeResult) {
          const id = `t${toolExecRounds}_auto_tree`
          yield {
            type: 'status',
            text: 'Inspecting workspace (model asked for structure)…'
          }
          yield {
            type: 'thinking',
            text: '\n\n— Inspecting the workspace to answer your request…\n'
          }
          yield {
            type: 'tool',
            tool: { id, name: 'tree', path: '.', status: 'running', detail: 'Running…' }
          }
          const treeResult = executeTool(workspacePath, {
            name: 'tree',
            args: { path: '.', maxDepth: 3 },
            raw: ''
          })
          lastTreeResult = treeResult.detail
          lastInspectResult = treeResult.detail
          inspectRounds++
          actionLog.push('Listed tree .')
          yield {
            type: 'tool',
            tool: {
              id,
              name: 'tree',
              path: '.',
              status: treeResult.ok ? 'ok' : 'error',
              detail: treeResult.detail.slice(0, AGENT_HANDOFF_CHARS)
            }
          }
          workerMessages.push({
            role: 'assistant',
            content: stripToolBlocks(assistantText).slice(0, AGENT_HANDOFF_CHARS)
          })
          appendToolObservation(workerMessages, 'tree', treeResult.detail, { path: '.' })
          workerMessages.push({
            role: 'system',
            content:
              `Do NOT ask the user for project structure or files — you have the listing above. ` +
              `Continue the original request with read_file / search_replace / write_file / run as needed.\n` +
              `User request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}`
          })
          constrainNextToolCall = true
          continue
        }

        // Pause for an inline answer when the model asks before continuing (even if
        // shouldKeepWorking would otherwise nudge tools immediately).
        const clarifyText = stripToolBlocks(assistantText).trim()
        if (
          options.askUser &&
          askUserCount < MAX_ASK_USER &&
          looksLikeClarifyingQuestion(assistantText)
        ) {
          askUserCount++
          yield { type: 'status', text: 'Waiting for your reply…' }
          yield {
            type: 'thinking',
            text: `\n\n— Asking you: ${clarifyText.slice(0, 200)}${clarifyText.length > 200 ? '…' : ''}\n`
          }
          const reply = await options.askUser(clarifyText)
          throwIfAborted(options.signal)
          workerMessages.push({
            role: 'assistant',
            content: clarifyText.slice(0, AGENT_HANDOFF_CHARS)
          })
          if (reply) {
            yield { type: 'thinking', text: `\n\n— You replied: ${reply.slice(0, 160)}\n` }
            workerMessages.push({
              role: 'user',
              content:
                `USER_REPLY:\n${reply}\n\n` +
                `Continue the original request with this answer. Prefer tools over more questions.`
            })
          } else {
            yield {
              type: 'thinking',
              text: '\n\n— No reply after five minutes — continuing with best judgment…\n'
            }
            workerMessages.push({
              role: 'system',
              content:
                `The user did not reply within five minutes. Proceed with the original request ` +
                `using your best judgment. Do not ask another clarifying question unless you are blocked.`
            })
          }
          yield { type: 'status', text: `${plan.agentName} continuing…` }
          continue
        }

        const keepGoing =
          shouldKeepWorking({
            needsTools: plan.requiresTools,
            mutated: workspaceMutated,
            assistantText,
            reviewOnly,
            inspectRounds,
            actions: actionLog,
            describeProject,
            chatReply
          }) ||
          abortedLoop ||
          looksLikeDegenerateLoop(assistantText)

        if (keepGoing) {
          noProgressStreak++
          // Next turn, force a valid tool-call JSON on the local model.
          constrainNextToolCall = true
          yield {
            type: 'thinking',
            text:
              noProgressStreak >= MAX_NO_PROGRESS
                ? '\n\n— Still not done; resetting context and continuing…\n'
                : `\n\n— Not done yet; ${plan.agentName} continuing…\n`
          }
          // Never stop — compact and keep pushing until finished.
          if (noProgressStreak >= MAX_NO_PROGRESS) {
            for await (const evt of compactWorkerContext({
              force: true,
              skipLiteSummary: true
            })) {
              yield evt
            }
            noProgressStreak = 0
          } else {
            workerMessages.push({
              role: 'assistant',
              content: assistantText.slice(0, AGENT_HANDOFF_CHARS)
            })
          }
          workerMessages.push(
            lastTreeResult
              ? nudgeContinueWork(
                  abortedLoop || looksLikeDegenerateLoop(assistantText)
                    ? 'You got stuck or answered before finishing.'
                    : looksLikeAsksForWorkspaceInfo(assistantText)
                      ? 'Do not ask the user for project structure or files — you already have a listing; read_file/run next.'
                      : 'That reply did not finish the user request.'
                )
              : nudgeToTools(
                  looksLikeAsksForWorkspaceInfo(assistantText)
                    ? 'Do not ask the user for project structure or files. Inspect the workspace with tools.'
                    : 'You must use tools to finish this request.'
                )
          )
          continue
        }

        // Final verify only for product-code edits — skip skills/rules/context under .eris/
        if (workspaceMutated && !codeMutated) {
          yield {
            type: 'thinking',
            text: '\n\n— Skipping project verify (only .eris skills/config changed).\n'
          }
        }
        if (codeMutated) {
          workflow.transition('verifying')
          yield { type: 'status', text: 'Final verify…' }
          const finalVerify = await runVerify(executionRoot!, options.signal, {
            preferTypecheck: false,
            allowInstall: true,
            approveInstall: options.approveCommand
              ? (cmd) => options.approveCommand!('run', cmd)
              : undefined
          })
          appendToolObservation(
            workerMessages,
            'run',
            `VERIFY_RESULT (${finalVerify.skipped ? 'skipped' : finalVerify.ok ? 'passed' : 'failed'}):\n${finalVerify.detail}`,
            { command: finalVerify.command }
          )
          if (!finalVerify.skipped && !finalVerify.ok) {
            workflow.noteVerification('failed')
            verifyFailures++
            yield { type: 'terminal', text: `$ ${finalVerify.command}\n${finalVerify.detail}\n` }
            if (verifyFailures >= MAX_VERIFY_FAILURES) {
              const workerNote = stripToolBlocks(assistantText).trim()
              const answer =
                buildWorkSummary(originalUserGoal, actionLog, workerNote) +
                `\n\nVerify still failing after ${verifyFailures} attempts:\n` +
                truncateForModel(finalVerify.detail, AGENT_HANDOFF_CHARS)
              yield {
                type: 'thinking',
                text: '\n\n— Verify failed too many times; stopping with a summary.\n'
              }
              yield {
                type: 'progress',
                step,
                actionLog: [...actionLog],
                filesTouched: [...filesTouched],
                incomplete: true
              }
              yield emitSessionStep('Stopped after verify failures')
              yield { type: 'answer', text: answer, replace: true }
              return
            }
            yield {
              type: 'thinking',
              text: `\n\n— Verify still failing (${verifyFailures}/${MAX_VERIFY_FAILURES}); fixing…\n`
            }
            workerMessages.push({
              role: 'assistant',
              content: assistantText.slice(0, AGENT_HANDOFF_CHARS)
            })
            const missingDeps = looksLikeMissingDeps(finalVerify.detail)
            const installHint = missingDeps
              ? installAttempts >= MAX_BARE_INSTALLS_PER_RUN && hasNodeModules(executionRoot!)
                ? ` Do NOT run bare npm install again — use npm install <package> for a missing dep, or fix imports.`
                : ` Missing modules: run npm install (or npm install <package>) in this workspace, then re-test.`
              : ` Do not run npm install for ordinary failures.`
            workerMessages.push({
              role: 'system',
              content:
                `Verification failed; inspect the tool result above.\n` +
                `You are NOT done. Fix these errors with write_file/read_file tools now.` +
                installHint
            })
            workflow.transition('executing')
            continue
          }
          if (!finalVerify.skipped && finalVerify.ok) {
            workflow.noteVerification('passed')
            verifyPassedOnce = true
            actionLog.push(`Verify passed: ${finalVerify.command}`)
          }
          if (finalVerify.skipped) {
            workflow.noteVerification('skipped')
            actionLog.push(`Verification skipped: ${finalVerify.detail}`)
          }
        }

        // Reject premature DONE (failed edits, tiny stubs, missing .app build).
        const goalCheck = assessGoalCompletion({
          goal: originalUserGoal,
          assistantText,
          actionLog,
          filesTouched,
          codeMutated,
          reviewOnly,
          onlyTinyStubs: productFilesAreTinyStubs(),
          verifyPassed: verifyPassedOnce
        })
        const outcomeCheck = workflow.evaluateOutcome({
          workspaceMutated,
          codeMutated,
          verifyPassed: verifyPassedOnce,
          filesTouched
        })
        const unmetReason = goalCheck.unmet ? goalCheck.reason : outcomeCheck.reason
        if (goalCheck.unmet || !outcomeCheck.ok) {
          goalRejectCount++
          constrainNextToolCall = true
          yield {
            type: 'thinking',
            text: `\n\n— Outcome check failed (${goalRejectCount}/${MAX_GOAL_REJECTS}): ${unmetReason}\n`
          }
          if (goalRejectCount >= MAX_GOAL_REJECTS) {
            workflow.block(unmetReason || 'The requested outcome was not achieved.')
            const workerNote = stripToolBlocks(assistantText).trim()
            const answer =
              buildWorkSummary(originalUserGoal, actionLog, workerNote) +
              `\n\nIncomplete: ${unmetReason}`
            yield {
              type: 'progress',
              step,
              actionLog: [...actionLog],
              filesTouched: [...filesTouched],
              incomplete: true
            }
            yield { type: 'status', text: 'Incomplete' }
            yield { type: 'answer', text: answer, replace: true }
            return
          }
          workerMessages.push({
            role: 'assistant',
            content: stripToolBlocks(assistantText).slice(0, AGENT_HANDOFF_CHARS)
          })
          workerMessages.push({
            role: 'system',
            content:
              `OUTCOME_CHECK_FAILED:\n${unmetReason}\n\n` +
              `You are NOT finished. Continue with tools (write_file / search_replace / run / verify) ` +
              `until the original request is truly satisfied. Do not claim DONE yet.\n` +
              `User request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}`
          })
          yield { type: 'status', text: `${plan.agentName} · goal unmet — continuing…` }
          if (workflow.snapshot().phase === 'verifying') workflow.transition('executing')
          continue
        }

        // Deterministic summary — never unload Full to reload Lite just for a recap.
        const prose = proseOutsideTools(assistantText)
        if (webLookup) {
          yield* answerFromWeb()
          return
        }
        const partial = unresolvedDelegationNote()
        if (prose.length >= 40 && !isToolLogReply(prose)) {
          workflow.complete()
          yield { type: 'status', text: partial ? 'Done · partial specialist results' : 'Done' }
          yield { type: 'answer', text: prose, replace: true }
          if (partial) yield { type: 'answer', text: `\n\n${partial}` }
          return
        }
        workflow.complete()
        yield* finishChatAnswer(assistantText)
        if (partial) yield { type: 'answer', text: `\n\n${partial}` }
        return
      }

      const onlyInspect = toolCalls.every(
        (c) => c.name === 'tree' || c.name === 'list_dir' || c.name === 'retrieve'
      )
      const fp = toolFingerprint(toolCalls)
      if (fp === lastFingerprint) repeatFingerprint++
      else {
        lastFingerprint = fp
        repeatFingerprint = 0
      }

      // Only skip when the SAME inspect call is repeated — not every list_dir after tree.
      const repeatedInspect = onlyInspect && repeatFingerprint >= 1
      const inspectBudgetExceeded = onlyInspect && inspectRounds >= 3

      if (repeatedInspect || inspectBudgetExceeded) {
        noProgressStreak++
        yield {
          type: 'thinking',
          text: repeatedInspect
            ? '\n\n— Same listing repeated; moving on…\n'
            : '\n\n— Enough directory listings; read files or finish…\n'
        }
        const snapshot = lastInspectResult || lastTreeResult || '(listing already returned earlier)'
        yield* recordSkippedToolCalls(
          toolCalls,
          assistantText,
          `Directory inspection was not executed again. Use the earlier listing and inspect a specific source file next.\n${snapshot}`
        )
        // After two skip cycles on review tasks, allow DONE without more tools
        if (reviewOnly && noProgressStreak >= 2) {
          workerMessages.push({
            role: 'system',
            content:
              `Stop calling tree/list_dir. Either emit ONE read_file or run tool, ` +
              `OR answer the actual request using inspected project sources. If evidence is missing, say the review is incomplete.`
          })
        } else {
          workerMessages.push(
            noProgressStreak >= MAX_NO_PROGRESS
              ? nudgeContinueWork(
                  reviewOnly
                    ? 'Stop listing directories. Read a source file, run tests, or DONE.'
                    : 'Stop inspecting. Finish the remaining file edits now.'
                )
              : nudgeAfterInspect(snapshot)
          )
        }
        if (noProgressStreak >= MAX_NO_PROGRESS) {
          for await (const evt of compactWorkerContext({
            force: true,
            skipLiteSummary: true
          })) {
            yield evt
          }
          noProgressStreak = 0
        }
        continue
      }

      if (repeatFingerprint >= 1 && !onlyInspect) {
        noProgressStreak++
        duplicateToolBlocks++
        yield {
          type: 'thinking',
          text: chatReply
            ? '\n\n— Same tool call repeated; answer the user from the files already read…\n'
            : '\n\n— Same tool call repeated; moving on to the next unfinished edit…\n'
        }
        yield* recordSkippedToolCalls(
          toolCalls,
          assistantText,
          'This identical tool request was not executed again. Inspect its previous result above. ' +
            'If it failed, correct the arguments or prerequisites. If it succeeded, continue with the next unfinished step.'
        )
        constrainNextToolCall = true
        workerMessages.push(
          nudgeContinueWork(
            'You repeated the same tool call. Move on to the next unfinished part of the request.'
          )
        )
        repeatFingerprint = 0
        if (duplicateToolBlocks >= MAX_DUPLICATE_TOOL_BLOCKS) {
          const stopNote =
            `Stopped after ${duplicateToolBlocks} repeated identical tool calls. ` +
            `Recovery did not produce a new action. This run is incomplete; existing workspace changes are preserved.`
          actionLog.push(stopNote)
          yield {
            type: 'progress',
            step,
            actionLog: [...actionLog],
            filesTouched: [...filesTouched],
            incomplete: true
          }
          yield emitSessionStep(stopNote)
          yield { type: 'status', text: 'Incomplete · repeated tool loop stopped' }
          yield {
            type: 'answer',
            text: `${buildWorkSummary(originalUserGoal, actionLog, latestAssistant)}\n\n${stopNote}`,
            replace: true
          }
          return
        }
        if (noProgressStreak >= MAX_NO_PROGRESS) {
          for await (const evt of compactWorkerContext({
            force: true,
            skipLiteSummary: true
          })) {
            yield evt
          }
          noProgressStreak = 0
        }
        continue
      }

      duplicateToolBlocks = 0

      toolExecRounds++
      yield {
        type: 'thinking',
        text: `\n\n— Running ${toolCalls.length} workspace tool${toolCalls.length === 1 ? '' : 's'}…\n`
      }

      workerMessages.push({
        role: 'assistant',
        content: thinkingBeforeTools(assistantText),
        ...{
          tool_calls: toolCalls.map((call) => ({
            id: call.id!,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: call.parseError ? call.raw : JSON.stringify(call.args)
            }
          }))
        }
      })

      const resultParts: string[] = []
      let mutatedThisRound = false
      let codeMutatedThisRound = false
      let inspectedSourceThisRound = false
      const parallelReadResults = new Map<number, ToolExecutionResult>()
      const parallelReadStartTimes = new Map<number, number>()
      const canRunReadBatch =
        toolCalls.length > 1 &&
        toolCalls.every((call) => {
          const contract = getToolContract(call.name)
          return (
            PARALLEL_READ_TOOLS.has(call.name) &&
            contract?.effect === 'read' &&
            toolAllowedByPolicy(call.name, plan.toolPolicy) &&
            validateToolArguments(call.args, contract.schema).ok &&
            !gateway.authorize(workspacePath, call)
          )
        })
      if (canRunReadBatch) {
        for (let index = 0; index < toolCalls.length; index++) {
          const call = toolCalls[index]!
          const id = `${task.taskId}:t${toolExecRounds}_${index}`
          parallelReadStartTimes.set(index, Date.now())
          yield {
            type: 'tool',
            tool: {
              id,
              name: call.name,
              path: argString(call.args, 'path') || undefined,
              status: 'running',
              effect: 'read',
              detail: 'Running in parallel…'
            }
          }
        }
        const readResults = await mapWithLimit(toolCalls, 4, (call) =>
          executeParallelReadTool(workspacePath, originalUserGoal, call, options.signal)
        )
        for (let index = 0; index < toolCalls.length; index++) {
          const call = toolCalls[index]!
          const result = readResults[index]!
          parallelReadResults.set(index, result)
          if (
            result.ok &&
            call.name === 'web_search' &&
            (!webSearchText || !firstHttpsResult(webSearchText))
          ) {
            webSearchText = result.detail
          }
          if (result.ok && call.name === 'web_open') {
            webPageText = [webPageText, result.detail].filter(Boolean).join('\n\n')
          }
        }
      }
      for (let i = 0; i < toolCalls.length; i++) {
        throwIfAborted(options.signal)
        const call = toolCalls[i]
        const id = `${task.taskId}:t${toolExecRounds}_${i}`
        const resultStart = resultParts.length
        let releaseWrite: (() => void) | undefined
        try {
          const toolStartedAt = parallelReadStartTimes.get(i) ?? Date.now()
          const precomputedResult = parallelReadResults.get(i)
          const mcpTool = call.name.startsWith('mcp__')
            ? mcpTools.find((tool) => tool.fqName === call.name)
            : undefined
          const toolContract = getToolContract(call.name)
          const toolEffect = mcpTool ? 'external' : (toolContract?.effect ?? 'external')
          if (!visibleToolNamesThisStep.has(call.name)) {
            const detail = `Tool ${call.name} was not available for this step. Use search_tools to discover built-in tools or search_mcp_tools for MCP tools, then call it on the next step.`
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                status: 'error',
                effect: toolEffect,
                changedResources: [],
                durationMs: Date.now() - toolStartedAt,
                failure: { code: 'unavailable', retryable: false },
                detail
              }
            }
            resultParts.push(`TOOL_RESULT ${call.name}: ${detail}`)
            continue
          }
          const validation = call.parseError
            ? { ok: false, errors: [call.parseError] }
            : validateToolArguments(call.args, mcpTool ? mcpTool.inputSchema : toolContract?.schema)
          if (!validation.ok) {
            constrainNextToolCall = true
            consecutiveToolErrors++
            const detail = `Invalid arguments: ${validation.errors.join('; ')}`
            actionLog.push(`Failed ${call.name}: ${detail}`)
            yield {
              type: 'progress',
              step,
              actionLog: [...actionLog],
              filesTouched: [...filesTouched]
            }
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                status: 'error',
                effect: toolEffect,
                changedResources: [],
                durationMs: Date.now() - toolStartedAt,
                failure: toolFailureMetadata(detail, toolEffect),
                detail
              }
            }
            resultParts.push(
              `TOOL_RESULT ${call.name}: ${detail}\nRECOVERY: ${toolFailureRecovery(call.name, detail)}\n` +
                `Expected arguments object: ${JSON.stringify(mcpTool ? mcpTool.inputSchema : toolContract?.schema)}\n` +
                'A validation failure does not mean the file is missing. No filesystem operation was executed.'
            )
            continue
          }
          const verificationRun = call.name === 'run' && verificationRunAllowed()
          if (verificationRun && !isVerifyCommand(argString(call.args, 'command'))) {
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                status: 'error',
                effect: toolEffect,
                changedResources: [],
                durationMs: Date.now() - toolStartedAt,
                failure: toolFailureMetadata(
                  'Verification runs may only use test, typecheck, or lint commands',
                  toolEffect
                ),
                detail: 'Verification runs may only use test, typecheck, or lint commands'
              }
            }
            resultParts.push(
              'TOOL_RESULT run: blocked. This task may only run test, typecheck, or lint commands (npm test, npm run typecheck, npx tsc, pytest, cargo test).\n' +
                `RECOVERY: ${toolFailureRecovery('run', 'Verification runs may only use test, typecheck, or lint commands')}`
            )
            continue
          }
          if (
            !toolAllowedByPolicy(call.name, plan.toolPolicy, mcpReadOnlyTools.has(call.name)) &&
            !verificationRun
          ) {
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                status: 'error',
                effect: toolEffect,
                changedResources: [],
                durationMs: Date.now() - toolStartedAt,
                failure: toolFailureMetadata(
                  `Blocked by tool policy (${plan.toolPolicy}) for agent ${plan.agentName}`,
                  toolEffect
                ),
                detail: `Blocked by tool policy (${plan.toolPolicy}) for agent ${plan.agentName}`
              }
            }
            resultParts.push(
              `TOOL_RESULT ${call.name}: blocked by policy ${plan.toolPolicy}\n` +
                `RECOVERY: ${toolFailureRecovery(call.name, `Blocked by tool policy (${plan.toolPolicy})`)}`
            )
            continue
          }
          const denied = gateway.authorize(workspacePath, call, mcpReadOnlyTools.has(call.name))
          if (denied) {
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                status: 'error',
                effect: toolEffect,
                detail: denied,
                changedResources: []
              }
            }
            resultParts.push(`TOOL_RESULT ${call.name}: ${denied}`)
            continue
          }
          if (['workspace', 'command', 'external'].includes(toolEffect)) {
            releaseWrite = await acquireProjectWrite(
              task.scope.projectRoot ?? workspacePath,
              options.signal
            )
            const stale = gateway.authorize(workspacePath, call, mcpReadOnlyTools.has(call.name))
            if (stale) {
              resultParts.push(`TOOL_RESULT ${call.name}: ${stale}`)
              yield { type: 'tool', tool: { id, name: call.name, status: 'error', detail: stale } }
              continue
            }
          }
          const path =
            typeof call.args.path === 'string'
              ? call.args.path
              : typeof call.args.to === 'string'
                ? call.args.to
                : typeof call.args.command === 'string'
                  ? call.args.command.slice(0, 80)
                  : typeof call.args.query === 'string'
                    ? call.args.query.slice(0, 80)
                    : typeof call.args.url === 'string'
                      ? call.args.url.slice(0, 80)
                      : undefined
          const readRequirement = toolContract?.readBeforeWrite
          const readFailure = readRequirement
            ? missingReadPrecondition(call, readRequirement)
            : null
          if (readFailure) {
            const detail = readFailure.detail
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                path: readFailure.path,
                status: 'error',
                effect: toolEffect,
                changedResources: [],
                durationMs: Date.now() - toolStartedAt,
                failure: toolFailureMetadata(detail, toolEffect),
                detail
              }
            }
            resultParts.push(
              `TOOL_RESULT ${call.name}: ${detail}\nRECOVERY: ${toolFailureRecovery(call.name, detail)}`
            )
            continue
          }
          if (!precomputedResult) {
            yield {
              type: 'tool',
              tool: {
                id,
                name: call.name,
                path,
                status: 'running',
                effect: toolEffect,
                detail: 'Running…'
              }
            }
          }

          let result: { ok: boolean; detail: string; mutated: boolean; path?: string }

          const approvalKind =
            toolContract?.approval === 'command'
              ? 'run'
              : toolContract?.approval === 'push' && argString(call.args, 'action') === 'push'
                ? 'push'
                : null
          const approvalCommand =
            approvalKind === 'run'
              ? argString(call.args, 'command')
              : approvalKind === 'push'
                ? 'git push'
                : ''
          let mcpApprovalDenied = false
          let mcpApprovalDetail = ''
          if (mcpTool) {
            if (options.approveMcpTool) {
              yield { type: 'status', text: `Waiting for approval: ${call.name}` }
              mcpApprovalDenied = !(await options.approveMcpTool(call.name, call.args))
              if (mcpApprovalDenied) {
                mcpApprovalDetail =
                  'The user denied this MCP tool call. Continue without retrying it.'
              }
            } else {
              mcpApprovalDenied = true
              mcpApprovalDetail = 'MCP tool was blocked because no approval handler is available.'
            }
          }
          let approvalDenied = false
          if (
            approvalCommand &&
            options.approveCommand &&
            !isGlobalInstallCommand(approvalCommand)
          ) {
            yield {
              type: 'status',
              text: `Waiting for approval: ${approvalCommand.slice(0, 80)}`
            }
            approvalDenied = !(await options.approveCommand(
              approvalKind === 'run' ? 'run' : 'push',
              approvalCommand
            ))
          }

          if (precomputedResult) {
            result = precomputedResult
          } else if (mcpApprovalDenied) {
            result = {
              ok: false,
              detail: mcpApprovalDetail,
              mutated: false
            }
            yield { type: 'thinking', text: `\n\n— MCP call denied: ${call.name}\n` }
          } else if (approvalDenied) {
            result = {
              ok: false,
              detail:
                `The user denied running \`${approvalCommand}\`. Do not retry it. ` +
                'Continue without it, or explain what the user should run themselves.',
              mutated: false
            }
            yield { type: 'thinking', text: `\n\n— Command denied by user: ${approvalCommand}\n` }
          } else if (call.name === 'generate_image') {
            try {
              const destination = argString(call.args, 'path')
              const target = resolveInWorkspace(workspacePath, destination)
              if (!destination.toLowerCase().endsWith('.png') || existsSync(target)) {
                throw new Error('Image destination must be a new .png file')
              }
              yield { type: 'status', text: 'Generating image…' }
              const asset = await generateImage({
                request: {
                  requestId: `image:${checkpoint.id}:${id}`,
                  prompt: argString(call.args, 'prompt'),
                  size: call.args.size == null ? undefined : ImageSizeSchema.parse(call.args.size)
                },
                settings: options.settings,
                getSecret: options.getSecret,
                signal: options.signal
              })
              await saveImageToWorkspace(workspacePath, asset.id, destination)
              const relativePath = toWorkspaceRelative(workspacePath, target)
              const record = recordBinaryCreateOp(workspacePath, checkpoint.id, relativePath)
              yield { type: 'asset', asset: { ...asset, path: relativePath } }
              yield {
                type: 'diff',
                diff: {
                  checkpointId: checkpoint.id,
                  opIndex: record.ops.length - 1,
                  path: relativePath,
                  before: null,
                  after: `Generated PNG: ${asset.width} × ${asset.height}`,
                  op: 'binary'
                }
              }
              result = {
                ok: true,
                detail: `Created ${relativePath} (${asset.width} × ${asset.height} PNG, ${asset.bytes} bytes). Use this path in the application.`,
                mutated: true,
                path: relativePath
              }
            } catch (error) {
              if (options.signal?.aborted) throw error
              result = {
                ok: false,
                detail: error instanceof Error ? error.message : 'Image generation failed',
                mutated: false
              }
            }
          } else if (call.name === 'run') {
            const command = argString(call.args, 'command')
            if (!command) {
              result = { ok: false, detail: 'command is required', mutated: false }
            } else if (isGlobalInstallCommand(command)) {
              result = {
                ok: false,
                detail:
                  'Blocked: global installs are not allowed. Install into this workspace instead ' +
                  '(e.g. `npm install <pkg>`, `npm install`, or a project venv — never `npm -g`).',
                mutated: false
              }
              yield {
                type: 'thinking',
                text: '\n\n— Blocked global install (workspace must stay self-contained).\n'
              }
            } else if (isInstallCommand(command)) {
              const addingPackage = isPackageAddInstall(command)
              const modulesPresent = hasNodeModules(executionRoot!)
              const pkgNewer = packageJsonNewerThanModules(executionRoot!)
              // Allow workspace installs freely; only stop bare reinstall loops.
              const needsInstall = !modulesPresent || pkgNewer
              const blockBareLoop =
                !addingPackage && !needsInstall && installAttempts >= MAX_BARE_INSTALLS_PER_RUN

              if (blockBareLoop) {
                result = {
                  ok: false,
                  detail:
                    `Blocked: bare install already ran ${MAX_BARE_INSTALLS_PER_RUN} times this session. ` +
                    'Use `npm install <package>` to add a dependency, or fix code/tests — do not loop install.',
                  mutated: false
                }
                yield {
                  type: 'thinking',
                  text: '\n\n— Skipped repeat bare install (anti-loop).\n'
                }
              } else {
                if (!addingPackage) installAttempts++
                yield { type: 'terminal', text: `$ ${command}\n` }
                yield {
                  type: 'thinking',
                  text: addingPackage
                    ? '\n\n— Installing package into workspace…\n'
                    : pkgNewer
                      ? '\n\n— package.json changed; refreshing workspace dependencies…\n'
                      : '\n\n— Installing workspace dependencies…\n'
                }
                const ran = await runWorkspaceCommand(
                  call.args.cwd
                    ? resolveInWorkspace(workspacePath, String(call.args.cwd))
                    : executionRoot!,
                  command,
                  {
                    signal: options.signal,
                    timeoutMs: 300_000
                  }
                )
                const out = [ran.stdout, ran.stderr].filter(Boolean).join('\n')
                if (out) yield { type: 'terminal', text: `${out}\n` }
                result = {
                  ok: ran.ok,
                  detail: ran.timedOut
                    ? `Timed out.\n${out}\n\nDo not re-run install in a loop. Try the test/build command next.`
                    : `exit ${ran.code ?? '?'}\n${out || '(no output)'}\n\n` +
                      (ran.ok
                        ? 'Install finished into this workspace (node_modules/.bin on PATH). Next: test/typecheck/build.'
                        : 'Install failed. Inspect the error or fix package.json; do not loop install.'),
                  mutated: false
                }
              }
            } else {
              yield { type: 'terminal', text: `$ ${command}\n` }
              const ran = await runWorkspaceCommand(
                call.args.cwd
                  ? resolveInWorkspace(workspacePath, String(call.args.cwd))
                  : executionRoot!,
                command,
                {
                  signal: options.signal
                }
              )
              const out = [ran.stdout, ran.stderr].filter(Boolean).join('\n')
              if (out) yield { type: 'terminal', text: `${out}\n` }
              result = {
                ok: ran.ok,
                detail: ran.timedOut
                  ? `Timed out.\n${out}`
                  : `exit ${ran.code ?? '?'}\n${out || '(no output)'}`,
                mutated: false
              }
            }
          } else if (call.name === 'web_search') {
            const query = argString(call.args, 'query')
            try {
              const detail = await searchWeb(query, options.signal)
              result = { ok: true, detail, mutated: false }
              if (!webSearchText || !firstHttpsResult(webSearchText)) webSearchText = detail
            } catch (err) {
              result = {
                ok: false,
                detail: err instanceof Error ? err.message : 'Web search failed',
                mutated: false
              }
            }
          } else if (call.name === 'web_open') {
            const url = argString(call.args, 'url')
            try {
              const detail = await openWebPage(url, options.signal)
              result = { ok: true, detail, mutated: false, path: url }
              webPageText = [webPageText, detail].filter(Boolean).join('\n\n')
            } catch (err) {
              result = {
                ok: false,
                detail: err instanceof Error ? err.message : 'Could not open the page',
                mutated: false,
                path: url
              }
            }
          } else if (call.name === 'notebook_read') {
            try {
              const notebook = readNotebook(
                workspacePath,
                argString(call.args, 'path'),
                typeof call.args.cell_index === 'number' ? call.args.cell_index : undefined
              )
              result = { ok: true, detail: notebook.detail, mutated: false, path: notebook.path }
            } catch (err) {
              result = {
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
                mutated: false
              }
            }
          } else if (call.name === 'lsp') {
            const path = argString(call.args, 'path')
            const action = argString(call.args, 'action')
            const line = typeof call.args.line === 'number' ? call.args.line : 0
            const character = typeof call.args.character === 'number' ? call.args.character : 0
            try {
              if (!path) throw new Error('lsp requires path')
              if (
                !Number.isInteger(line) ||
                line < 1 ||
                !Number.isInteger(character) ||
                character < 1
              ) {
                throw new Error('lsp line and character must be positive one-based integers')
              }
              const file = readWorkspaceFile(workspacePath, path, 1_000_000)
              if (file.truncated) throw new Error('LSP queries are limited to files under 1 MB')
              const absPath = resolveInWorkspace(workspacePath, path)
              if (!(await lspEnsureOpen(workspacePath, absPath, '', file.content))) {
                throw new Error('No language server is configured for this file.')
              }
              const displayPath = (target: string): string =>
                isPathInside(workspacePath, target)
                  ? toWorkspaceRelative(workspacePath, target)
                  : target
              if (action === 'hover') {
                const hover = await lspHover(workspacePath, absPath, line, character)
                result = {
                  ok: hover.ok,
                  detail:
                    hover.contents ||
                    (hover.ok
                      ? '(no hover information at this position)'
                      : 'No language server is available for this file.'),
                  mutated: false,
                  path: file.path
                }
              } else if (action === 'definition') {
                const definitions = await lspDefinition(workspacePath, absPath, line, character)
                result = {
                  ok: definitions.ok,
                  detail: definitions.ok
                    ? definitions.locations.length
                      ? definitions.locations
                          .map((item) => `${displayPath(item.path)}:${item.line}`)
                          .join('\n')
                      : '(no definition found)'
                    : 'No language server is available for this file.',
                  mutated: false,
                  path: file.path
                }
              } else if (action === 'references') {
                const references = await lspReferences(workspacePath, absPath, line, character)
                result = {
                  ok: references.ok,
                  detail: references.ok
                    ? references.locations.length
                      ? references.locations
                          .map((item) => `${displayPath(item.path)}:${item.line}`)
                          .join('\n')
                      : '(no references found)'
                    : 'No language server is available for this file.',
                  mutated: false,
                  path: file.path
                }
              } else if (action === 'completion') {
                const completion = await lspCompletion(workspacePath, absPath, line, character)
                result = {
                  ok: completion.ok,
                  detail: completion.ok
                    ? completion.items.length
                      ? completion.items
                          .slice(0, 25)
                          .map((item) => `${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
                          .join('\n')
                      : '(no completion items)'
                    : 'No language server is available for this file.',
                  mutated: false,
                  path: file.path
                }
              } else {
                result = {
                  ok: false,
                  detail: `Unknown LSP action: ${action}`,
                  mutated: false,
                  path
                }
              }
            } catch (err) {
              result = {
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
                mutated: false,
                path: path || undefined
              }
            }
          } else if (call.name === 'grep') {
            const pattern = argString(call.args, 'pattern') || argString(call.args, 'query')
            const glob = argString(call.args, 'glob') || undefined
            const grepped = await workspaceGrep(workspacePath, pattern, { glob })
            result = { ok: grepped.ok, detail: grepped.detail, mutated: false }
          } else if (call.name === 'glob') {
            const pattern = argString(call.args, 'pattern') || '**/*'
            const globbed = workspaceGlob(workspacePath, pattern)
            result = { ok: globbed.ok, detail: globbed.detail, mutated: false }
          } else if (call.name === 'search_symbols') {
            const query = argString(call.args, 'query') || argString(call.args, 'pattern')
            const found = await findSymbols(workspacePath, query)
            result = { ok: found.ok, detail: found.detail, mutated: false }
          } else if (call.name === 'find_references') {
            const name =
              argString(call.args, 'name') ||
              argString(call.args, 'query') ||
              argString(call.args, 'symbol')
            const found = await findReferences(workspacePath, name)
            result = { ok: found.ok, detail: found.detail, mutated: false }
          } else if (call.name === 'semantic_search') {
            const query =
              argString(call.args, 'query') || argString(call.args, 'pattern') || originalUserGoal
            const retrieved = await inspectWorkspace(workspacePath, query, 8)
            result = { ok: retrieved.ok, detail: retrieved.detail, mutated: false }
          } else if (call.name === 'related_files') {
            const path = argString(call.args, 'path') || argString(call.args, 'file')
            const related = await relatedFiles(workspacePath, path)
            result = { ok: related.ok, detail: related.detail, mutated: false }
          } else if (call.name === 'retrieve') {
            const query =
              argString(call.args, 'query') || argString(call.args, 'pattern') || originalUserGoal
            const retrieved = await inspectWorkspace(workspacePath, query, 8)
            result = { ok: retrieved.ok, detail: retrieved.detail, mutated: false }
          } else if (call.name === 'read_context') {
            const prompt = formatWorkspaceContextPrompt(workspacePath, { full: true })
            const doc = getWorkspaceContext(workspacePath)
            result = {
              ok: true,
              detail:
                prompt ||
                '(empty — edit .eris/context.md or use update_context to save workspace facts)',
              path: '.eris/context.md',
              mutated: false
            }
            if (doc.pin) {
              result.detail = `${prompt}\n\n[pin length ${doc.pin.length} chars]`
            }
          } else if (call.name === 'list_skills') {
            result = {
              ok: true,
              detail: formatSkillsListForAgent(workspacePath),
              path: userSkillsDir(),
              mutated: false
            }
          } else if (call.name === 'read_skill') {
            const idRaw =
              argString(call.args, 'id') ||
              argString(call.args, 'skill_id') ||
              argString(call.args, 'name')
            const id = idRaw ? slugifySkillId(idRaw) : ''
            const scopeRaw = (argString(call.args, 'scope') || '').toLowerCase()
            const scope =
              scopeRaw === 'workspace' || scopeRaw === 'user'
                ? (scopeRaw as 'user' | 'workspace')
                : undefined
            const skill = id ? getSkill(workspacePath, id, scope) : null
            result = skill
              ? {
                  ok: true,
                  detail:
                    `id: ${skill.id}\nscope: ${skill.scope}\nname: ${skill.name}\n` +
                    `description: ${skill.description}\npath: ${skill.path}\n\n${skill.body}`,
                  path: skill.path,
                  mutated: false
                }
              : {
                  ok: false,
                  detail: id
                    ? `Skill “${id}” not found${scope ? ` in ${scope} scope` : ''}`
                    : 'read_skill requires id',
                  mutated: false
                }
          } else if (call.name === 'write_skill') {
            const skillName =
              argString(call.args, 'skill_name') ||
              argString(call.args, 'name') ||
              argString(call.args, 'title')
            const description =
              argString(call.args, 'description') || argString(call.args, 'desc') || ''
            const body =
              argString(call.args, 'body') ||
              argString(call.args, 'content') ||
              argString(call.args, 'instructions')
            const idArg =
              argString(call.args, 'id') || argString(call.args, 'skill_id') || skillName
            const scopeRaw = (argString(call.args, 'scope') || 'user').toLowerCase()
            const scope = scopeRaw === 'workspace' ? 'workspace' : 'user'
            if (!skillName.trim() || !body.trim()) {
              result = {
                ok: false,
                detail: 'write_skill requires skill_name and body (markdown instructions)',
                mutated: false
              }
            } else {
              try {
                const skill = upsertSkill(workspacePath, {
                  id: idArg,
                  name: skillName,
                  description,
                  body,
                  scope
                })
                result = {
                  ok: true,
                  detail:
                    `Saved ${skill.scope} skill “${skill.name}” (${skill.id})\n` +
                    `path: ${skill.path}\n` +
                    (skill.scope === 'user'
                      ? 'Stored outside the project (user skills folder).'
                      : 'Stored in this project under .eris/skills/.'),
                  path: skill.path,
                  // Skill files are not product code — never trigger npm/test verify.
                  mutated: false
                }
                yield { type: 'workspace-changed' }
              } catch (err) {
                result = {
                  ok: false,
                  detail: err instanceof Error ? err.message : String(err),
                  mutated: false
                }
              }
            }
          } else if (call.name === 'update_context') {
            const text =
              argString(call.args, 'text') ||
              argString(call.args, 'content') ||
              argString(call.args, 'note')
            const mode = (argString(call.args, 'mode') || 'append').toLowerCase()
            if (!text.trim()) {
              result = { ok: false, detail: 'update_context requires text', mutated: false }
            } else if (mode === 'summary' || mode === 'set_summary') {
              const doc = setContextSummary(workspacePath, text)
              result = {
                ok: true,
                detail: `Updated pinned Summary (${doc.pin.length} chars).\nPin:\n${doc.pin}`,
                path: '.eris/context.md',
                // Not a source-tree mutation — skip verify/diff pipeline.
                mutated: false
              }
            } else {
              const doc = appendContextNote(workspacePath, text)
              result = {
                ok: true,
                detail: `Appended note to .eris/context.md.\nPin:\n${doc.pin || '(no summary yet)'}`,
                path: '.eris/context.md',
                mutated: false
              }
            }
          } else if (call.name === 'ask_user') {
            const question =
              argString(call.args, 'question') ||
              argString(call.args, 'prompt') ||
              argString(call.args, 'text')
            const choices = Array.isArray(call.args.choices)
              ? call.args.choices
                  .map((c) => String(c))
                  .filter(Boolean)
                  .slice(0, 6)
              : undefined
            if (!question.trim()) {
              result = { ok: false, detail: 'ask_user requires question', mutated: false }
            } else if (askUserCount >= MAX_ASK_USER) {
              result = {
                ok: true,
                detail:
                  'Ask budget exhausted for this run. Proceed with best judgment; do not ask again.',
                mutated: false
              }
              yield {
                type: 'thinking',
                text: '\n\n— Skipping further questions (limit reached) — continuing…\n'
              }
            } else if (!options.askUser) {
              result = {
                ok: true,
                detail:
                  'User prompt UI unavailable. Proceed with best judgment on the original request.',
                mutated: false
              }
            } else {
              askUserCount++
              yield { type: 'status', text: 'Waiting for your reply…' }
              yield {
                type: 'thinking',
                text: `\n\n— Asking you: ${question.slice(0, 200)}${question.length > 200 ? '…' : ''}\n`
              }
              const reply = await options.askUser(question.trim(), choices)
              throwIfAborted(options.signal)
              if (reply) {
                result = {
                  ok: true,
                  detail: `User replied:\n${reply}\n\nContinue with this answer. Prefer tools over more questions.`,
                  mutated: false
                }
                yield {
                  type: 'thinking',
                  text: `\n\n— You replied: ${reply.slice(0, 160)}\n`
                }
              } else {
                result = {
                  ok: true,
                  detail:
                    'User did not reply within five minutes. Proceed with the original request using your best judgment. Do not ask another clarifying question unless you are blocked.',
                  mutated: false
                }
                yield {
                  type: 'thinking',
                  text: '\n\n— No reply after five minutes — continuing with best judgment…\n'
                }
              }
              yield { type: 'status', text: `${plan.agentName} continuing…` }
            }
          } else if (call.name === 'delegate_to_agent') {
            const agentId = argString(call.args, 'agent_id') || argString(call.args, 'agentId')
            const goal = argString(call.args, 'goal')
            const summary = argString(call.args, 'summary') || goal
            const claim = argString(call.args, 'claim') || undefined
            const confidence =
              typeof call.args.confidence === 'number' ? call.args.confidence : undefined
            const files = Array.isArray(call.args.files)
              ? call.args.files.map((f) => String(f)).filter(Boolean)
              : undefined
            const openQuestions = Array.isArray(call.args.open_questions)
              ? call.args.open_questions.map((q) => String(q)).filter(Boolean)
              : Array.isArray(call.args.openQuestions)
                ? call.args.openQuestions.map((q) => String(q)).filter(Boolean)
                : undefined
            const handoff: AgentHandoffPacket = {
              task,
              parentGoal: originalUserGoal,
              goal,
              summary,
              files,
              openQuestions,
              confidence,
              fromAgentId: plan.agentId,
              toAgentId: agentId
            }
            if (!agentId || !goal) {
              result = {
                ok: false,
                detail: 'delegate_to_agent requires agent_id and goal',
                mutated: false
              }
            } else if (options.allowDelegate === false) {
              result = {
                ok: false,
                detail:
                  'A specialist does not delegate further. Finish the assigned goal yourself.',
                mutated: false
              }
            } else if (!findAgent(workspacePath, agentId)?.enabled) {
              result = {
                ok: false,
                detail: `Agent ${agentId} is unavailable or disabled. Choose an enabled specialist.`,
                mutated: false
              }
            } else if (options.jobId?.startsWith('chat:')) {
              const specialist = findAgent(workspacePath, agentId)
              // The child is the specialist that was asked for, within its own tool
              // ceiling. Routing the goal must not swap in an editor or force edits.
              const specialistPlan = await planChatTurn({
                workspacePath,
                settings: options.settings,
                context: {
                  text: goal,
                  selectedModel: workerModel,
                  mode: 'agent',
                  manualAgentId: agentId,
                  skipModelRouter: true
                },
                getSecret: options.getSecret,
                signal: options.signal
              })
              const specialistCeiling = specialist?.tools ?? 'read'
              const specialistCanEdit = ['edit', 'full'].includes(specialistCeiling)
              if (specialistPlan.agentId !== agentId || !intentNeedsTools(specialistPlan.intent)) {
                specialistPlan.agentId = agentId
                specialistPlan.agentName = specialist?.name || agentId
                if (!specialistCanEdit && intentNeedsMutation(specialistPlan.intent))
                  specialistPlan.intent = 'review'
                if (!intentNeedsTools(specialistPlan.intent))
                  specialistPlan.intent = specialistCanEdit ? 'edit' : 'explore'
              }
              specialistPlan.toolPolicy = specialist
                ? effectiveToolPolicy(specialist, specialistPlan.intent, 'agent')
                : minCeiling(specialistPlan.toolPolicy, specialistCeiling)
              specialistPlan.requiresTools = specialistPlan.toolPolicy !== 'none'
              specialistPlan.models = {
                ...specialistPlan.models,
                chat: workerModel,
                tools: workerModel
              }
              specialistPlan.task = childTaskContract(
                task,
                specialistPlan,
                goal,
                workspacePath,
                `${task.taskId}:${agentId}:${step}`
              )
              specialistPlan.toolPolicy = intersectToolPolicy(specialistPlan.toolPolicy, task)
              specialistPlan.escalateToFull = false
              specialistPlan.cloudPreferred = false
              const delegationId = `${options.jobId}:${agentId}:${step}`
              const runningDelegation = {
                id: delegationId,
                agentId,
                agentName: specialist?.name || specialistPlan.agentName || agentId,
                goal,
                status: 'running' as const,
                tools: [] as Array<{ name: string; path?: string; status: string }>,
                result: ''
              }
              yield { type: 'delegation', delegation: runningDelegation }
              yield {
                type: 'thinking',
                text: `\n\n— ${runningDelegation.agentName} working in this workspace…\n`
              }
              releaseGgufSession()
              let answer = ''
              let specialistMutated = false
              let specialistIncomplete = false
              const specTools: Array<{ name: string; path?: string; status: string }> = []
              try {
                for await (const specEvt of runAgentWithWorkspaceTools({
                  workspacePath,
                  settings: options.settings,
                  model: workerModel,
                  messages: [
                    { role: 'system', content: formatHandoffForPrompt(handoff) },
                    { role: 'user', content: goal }
                  ],
                  temperature: specialist?.temperature ?? options.temperature,
                  signal: options.signal,
                  getSecret: options.getSecret,
                  mode: 'agent',
                  turnPlan: specialistPlan,
                  approveCommand: options.approveCommand,
                  approveMcpTool: options.approveMcpTool,
                  askUser: options.askUser,
                  mcp: 'reuse',
                  jobId: `${options.jobId}:inline:${agentId}`,
                  allowDelegate: false
                })) {
                  if (
                    specEvt.type === 'thinking' ||
                    specEvt.type === 'tool' ||
                    specEvt.type === 'evidence' ||
                    specEvt.type === 'diff' ||
                    specEvt.type === 'status' ||
                    specEvt.type === 'workspace-changed' ||
                    specEvt.type === 'checkpoint' ||
                    specEvt.type === 'terminal'
                  ) {
                    yield specEvt
                  }
                  if (specEvt.type === 'diff') {
                    specialistMutated = true
                    filesTouched.push(specEvt.diff.path)
                    forgetWorkspaceRead(specEvt.diff.path)
                    if (pathNeedsProjectVerify(specEvt.diff.path)) {
                      codeMutated = true
                      codeMutatedThisRound = true
                      verifyPassedOnce = false
                      workflow.invalidateVerification()
                    }
                  }
                  if (specEvt.type === 'progress' && specEvt.incomplete) specialistIncomplete = true
                  if (specEvt.type === 'answer')
                    answer = specEvt.replace ? specEvt.text : answer + specEvt.text
                  if (specEvt.type === 'tool' && specEvt.tool.status !== 'running') {
                    specTools.push({
                      name: specEvt.tool.name,
                      path: specEvt.tool.path,
                      status: specEvt.tool.status
                    })
                  }
                }
                // A specialist claim with no tool evidence is a lead, not a fact.
                const unverified = Boolean(answer.trim()) && specTools.length === 0
                result = {
                  ok: !specialistIncomplete && Boolean(answer.trim()),
                  detail: [
                    specialistIncomplete
                      ? 'Specialist stopped before completing the assignment.'
                      : '',
                    unverified
                      ? 'Unverified: the specialist cited no tool evidence. Check its claims against the source before relying on them.'
                      : '',
                    `Specialist: ${runningDelegation.agentName}. Workspace: current chat workspace.`,
                    `Tool evidence: ${specTools.map((tool) => `${tool.name}${tool.path ? ` ${tool.path}` : ''}: ${tool.status}`).join('; ') || 'none'}`,
                    answer.trim() ||
                      'Specialist returned no answer; the assignment remains unresolved.'
                  ]
                    .filter(Boolean)
                    .join('\n'),
                  mutated: specialistMutated
                }
                recordDelegation(
                  agentId,
                  goal,
                  !result.ok ? 'failed' : unverified ? 'unverified' : 'done',
                  specialistPlan.task
                )
                yield {
                  type: 'delegation',
                  delegation: {
                    ...runningDelegation,
                    status: result.ok ? 'done' : 'failed',
                    tools: specTools.slice(-6),
                    result: result.detail.slice(0, AGENT_HANDOFF_CHARS)
                  }
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                result = { ok: false, detail: message, mutated: specialistMutated }
                recordDelegation(
                  agentId,
                  goal,
                  options.signal?.aborted ? 'cancelled' : 'failed',
                  specialistPlan.task
                )
                yield {
                  type: 'delegation',
                  delegation: {
                    ...runningDelegation,
                    status: 'failed',
                    tools: specTools.slice(-6),
                    result: message.slice(0, AGENT_HANDOFF_CHARS)
                  }
                }
              }
              actionLog.push(`Delegated → ${agentId}: ${goal.slice(0, 80)}`)
            } else if (!options.onDelegate) {
              result = {
                ok: false,
                detail: 'Delegation is unavailable in this run context',
                mutated: false
              }
            } else {
              const delegated = await options.onDelegate({
                agentId,
                goal,
                summary,
                files,
                openQuestions,
                confidence,
                claim,
                handoff
              })
              result = {
                ok: delegated.ok,
                detail: delegated.detail,
                mutated: false
              }
              if (delegated.ok) {
                yield {
                  type: 'adapt',
                  kind: 'delegate',
                  reason: `Delegated to ${agentId}: ${goal.slice(0, 120)}`,
                  agentId,
                  childJobId: delegated.childJobId
                }
                actionLog.push(`Delegated → ${agentId}: ${goal.slice(0, 80)}`)
              }
            }
          } else if (call.name === 'await_children') {
            if (!options.onAwaitChildren) {
              result = {
                ok: false,
                detail: 'await_children requires a background/orchestrator job context',
                mutated: false
              }
            } else {
              yield { type: 'status', text: 'Waiting for children…' }
              const timeoutMs =
                typeof call.args.timeout_ms === 'number' ? call.args.timeout_ms : 600_000
              const awaited = await options.onAwaitChildren(timeoutMs)
              result = { ok: awaited.ok, detail: awaited.detail, mutated: false }
            }
          } else if (call.name === 'search_tools') {
            result = {
              ok: true,
              detail: discoverTools(argString(call.args, 'query')),
              mutated: false
            }
          } else if (mcpMode !== 'off' && isMcpToolName(call.name)) {
            const mcpResult = await callMcpTool(call.name, call.args)
            result = { ok: mcpResult.ok, detail: mcpResult.detail, mutated: false }
          } else if (call.name === 'search_mcp_tools') {
            result = {
              ok: true,
              detail: discoverMcpTools(argString(call.args, 'query')),
              mutated: false
            }
          } else if (
            call.name === 'write_file' ||
            call.name === 'search_replace' ||
            call.name === 'apply_patch' ||
            call.name === 'notebook_edit'
          ) {
            const writePath =
              call.name === 'apply_patch'
                ? '' // resolved inside tool
                : argString(call.args, 'path')
            let before: string | null = writePath
              ? snapshotBeforeWrite(workspacePath, checkpoint.id, writePath)
              : null
            let afterContent: string | null =
              call.name === 'write_file' && typeof call.args.content === 'string'
                ? call.args.content
                : null
            if (call.name === 'search_replace' && writePath) {
              try {
                const oldString =
                  argString(call.args, 'old_string') || argString(call.args, 'oldString')
                const newString =
                  typeof call.args.new_string === 'string'
                    ? call.args.new_string
                    : typeof call.args.newString === 'string'
                      ? call.args.newString
                      : ''
                const replaceAll = Boolean(call.args.replace_all ?? call.args.replaceAll)
                const edited = searchReplaceInFile(
                  workspacePath,
                  writePath,
                  oldString,
                  newString,
                  replaceAll
                )
                before = edited.before
                afterContent = edited.after
                result = {
                  ok: true,
                  detail: `Replaced ${edited.replacements} occurrence(s) in ${edited.path}`,
                  mutated: true,
                  path: edited.path
                }
              } catch (err) {
                result = {
                  ok: false,
                  detail: err instanceof Error ? err.message : String(err),
                  mutated: false,
                  path: writePath || undefined
                }
              }
            } else if (call.name === 'notebook_edit') {
              try {
                const edited = editNotebookCell(workspacePath, {
                  path: writePath,
                  operation: argString(call.args, 'operation') as
                    'replace_source' | 'insert_before' | 'insert_after' | 'delete',
                  cellIndex:
                    typeof call.args.cell_index === 'number' ? call.args.cell_index : Number.NaN,
                  source: typeof call.args.source === 'string' ? call.args.source : undefined,
                  cellType:
                    call.args.cell_type === 'markdown' || call.args.cell_type === 'raw'
                      ? call.args.cell_type
                      : 'code'
                })
                before = edited.before
                afterContent = edited.after
                result = { ok: true, detail: edited.detail, mutated: true, path: edited.path }
              } catch (err) {
                result = {
                  ok: false,
                  detail: err instanceof Error ? err.message : String(err),
                  mutated: false,
                  path: writePath || undefined
                }
              }
            } else if (call.name === 'apply_patch') {
              try {
                const patch = argString(call.args, 'patch') || argString(call.args, 'diff')
                const edited = applyUnifiedPatch(workspacePath, patch)
                before = edited.before
                afterContent = edited.after
                result = {
                  ok: true,
                  detail: `Applied patch to ${edited.path}`,
                  mutated: true,
                  path: edited.path
                }
              } catch (err) {
                result = {
                  ok: false,
                  detail: err instanceof Error ? err.message : String(err),
                  mutated: false
                }
              }
            } else {
              result = executeTool(workspacePath, call)
            }
            if (result.ok && result.path && afterContent != null) {
              const rec = recordWriteOp(
                workspacePath,
                checkpoint.id,
                result.path,
                before,
                afterContent
              )
              const opIndex = rec ? rec.ops.length - 1 : 0
              invalidateDiagnosticsCache()
              yield {
                type: 'diff',
                diff: {
                  checkpointId: checkpoint.id,
                  opIndex,
                  path: result.path,
                  before,
                  after: afterContent,
                  op: 'write'
                }
              }
            }
          } else if (call.name === 'git_status') {
            const st = await gitStatus(workspacePath)
            if (!st.ok) {
              result = { ok: false, detail: st.error || 'git status failed', mutated: false }
            } else {
              const lines = [
                `branch ${st.branch || '?'} ↑${st.ahead} ↓${st.behind}`,
                ...st.entries.map((e) => `${e.status} ${e.path}`)
              ]
              result = {
                ok: true,
                detail: lines.join('\n') || 'clean',
                mutated: false
              }
            }
          } else if (call.name === 'git_diff') {
            const path = argString(call.args, 'path') || undefined
            const d = await gitDiff(workspacePath, path)
            result = {
              ok: d.ok,
              detail: d.ok ? d.diff : d.error || 'git diff failed',
              mutated: false,
              path
            }
          } else if (call.name === 'git_stage') {
            const paths = Array.isArray(call.args.paths)
              ? call.args.paths.map(String)
              : argString(call.args, 'path')
                ? [argString(call.args, 'path')]
                : []
            const staged = await gitStage(workspacePath, paths)
            result = {
              ok: staged.ok,
              detail: staged.ok ? `Staged ${paths.join(', ')}` : staged.error || 'stage failed',
              mutated: false
            }
          } else if (call.name === 'git_commit') {
            const message = argString(call.args, 'message')
            const committed = await gitCommit(workspacePath, message)
            result = {
              ok: committed.ok,
              detail: committed.ok ? `Committed: ${message}` : committed.error || 'commit failed',
              mutated: committed.ok
            }
          } else if (call.name === 'git_stash') {
            const action = (argString(call.args, 'action', 'push') || 'push') as
              'push' | 'pop' | 'list'
            const message = argString(call.args, 'message') || undefined
            const stashed = await gitStash(workspacePath, action, message)
            result = {
              ok: stashed.ok,
              detail: stashed.ok
                ? stashed.output || `stash ${action} ok`
                : stashed.error || 'stash failed',
              mutated: action !== 'list' && stashed.ok
            }
          } else if (call.name === 'git_sync') {
            const action = (argString(call.args, 'action', 'pull') || 'pull') as
              'fetch' | 'pull' | 'push'
            const settings = options.settings
            const remoteName = settings?.github?.remoteName || 'origin'
            const branch = (await gitStatus(workspacePath)).branch
            const tokenRef = settings?.github?.tokenRef
            const token = tokenRef ? options.getSecret(tokenRef) : null
            const ref = settings?.github?.repository
              ? parseGithubRepo(settings.github.repository, settings.github.host || 'github.com')
              : null
            const synced = await pushPullFetch(
              workspacePath,
              action,
              remoteName,
              branch,
              token,
              ref,
              settings?.github?.preferredProtocol || 'https'
            )
            result = {
              ok: synced.ok,
              detail: synced.ok
                ? synced.output || `${action} ok`
                : synced.error || `${action} failed`,
              mutated: false
            }
          } else if (call.name === 'delete_path') {
            const delPath = argString(call.args, 'path')
            let before = ''
            let wasDirectory = false
            if (delPath) {
              try {
                const abs = resolveInWorkspace(workspacePath, delPath)
                if (existsSync(abs)) {
                  wasDirectory = statSync(abs).isDirectory()
                  if (!wasDirectory) before = readFileSync(abs, 'utf8')
                }
              } catch {
                // ignore
              }
            }
            result = executeTool(workspacePath, call)
            if (result.ok && delPath) {
              const rec = recordDeleteOp(
                workspacePath,
                checkpoint.id,
                delPath,
                before,
                wasDirectory
              )
              const opIndex = rec ? rec.ops.length - 1 : 0
              yield {
                type: 'diff',
                diff: {
                  checkpointId: checkpoint.id,
                  opIndex,
                  path: result.path ?? delPath,
                  before,
                  after: '',
                  op: 'delete'
                }
              }
            }
          } else if (call.name === 'rename_path') {
            const from = argString(call.args, 'path')
            const to = argString(call.args, 'to')
            const before = from ? snapshotBeforeWrite(workspacePath, checkpoint.id, from) : null
            result = executeTool(workspacePath, call)
            if (result.ok && from && to) {
              const rec = recordRenameOp(workspacePath, checkpoint.id, from, to, before)
              const opIndex = rec ? rec.ops.length - 1 : 0
              yield {
                type: 'diff',
                diff: {
                  checkpointId: checkpoint.id,
                  opIndex,
                  path: `${from} → ${to}`,
                  before,
                  after: before ?? '',
                  op: 'rename'
                }
              }
            }
          } else if (call.name === 'mkdir') {
            const mkdirPath = argString(call.args, 'path')
            result = executeTool(workspacePath, call)
            if (result.ok && result.mutated && mkdirPath) {
              const rec = recordMkdirOp(workspacePath, checkpoint.id, mkdirPath)
              const opIndex = rec ? rec.ops.length - 1 : 0
              yield {
                type: 'diff',
                diff: {
                  checkpointId: checkpoint.id,
                  opIndex,
                  path: result.path ?? mkdirPath,
                  before: null,
                  after: '',
                  op: 'mkdir'
                }
              }
            }
          } else {
            result = executeTool(workspacePath, call)
          }

          if (result.mutated) {
            mutatedThisRound = true
            workspaceMutated = true
            forgetWorkspaceRead(result.path)
            if (call.name === 'rename_path') forgetWorkspaceRead(argString(call.args, 'path'))
            if (result.path) filesTouched.push(result.path)
            if (pathNeedsProjectVerify(result.path)) {
              codeMutated = true
              codeMutatedThisRound = true
              verifyPassedOnce = false
              workflow.invalidateVerification()
            }
          }
          workflow.noteTool({ ...result, name: call.name })
          yield { type: 'evidence', evidence: gateway.record(`${task.taskId}:${id}`, call, result) }
          if (call.name === 'run' || call.name === 'git_sync' || mcpTool) {
            // Commands and external tools may alter files without reporting their paths.
            observedWorkspaceReads.clear()
          }
          if (result.ok) {
            // Reading distinct source/ranges is productive work, even before an
            // edit. Do not reroute an agent just for inspecting several files.
            if (toolEffect === 'read' && !onlyInspect) inspectedSourceThisRound = true
            if (call.name === 'read_file' && result.path) {
              recordWorkspaceRead(result.path, 'file')
            } else if (call.name === 'notebook_read' && result.path) {
              recordWorkspaceRead(result.path, 'notebook')
            }
            if (
              call.name === 'read_file' &&
              result.path &&
              !result.path.replace(/\\/g, '/').startsWith('.eris/')
            ) {
              sourceReads.push({
                path: result.path,
                text: result.detail.slice(0, AGENT_HANDOFF_CHARS)
              })
            }
            if (call.name === 'tree') {
              lastTreeResult = result.detail
              lastInspectResult = result.detail
            } else if (call.name === 'list_dir' || call.name === 'retrieve') {
              lastInspectResult = result.detail
              if (!lastTreeResult) lastTreeResult = result.detail
            }
            const label =
              call.name === 'write_file' ||
              call.name === 'search_replace' ||
              call.name === 'apply_patch' ||
              call.name === 'mkdir' ||
              call.name === 'delete_path' ||
              call.name === 'rename_path' ||
              call.name === 'run' ||
              call.name.startsWith('git_')
                ? result.detail.split('\n')[0]!.slice(0, 160)
                : call.name === 'read_file'
                  ? `Read ${result.path ?? path ?? 'file'}`
                  : call.name === 'tree' || call.name === 'list_dir'
                    ? `Inspected ${result.path ?? path ?? '.'}`
                    : call.name === 'verify'
                      ? `Verify ${result.ok ? 'ok' : 'fail'}`
                      : result.detail.slice(0, AGENT_HANDOFF_CHARS)
            actionLog.push(label)
            consecutiveToolErrors = 0
          } else {
            consecutiveToolErrors++
            actionLog.push(
              `Failed ${call.name}${path ? ` ${path}` : ''}: ${result.detail.slice(0, AGENT_HANDOFF_CHARS)}`
            )
          }
          yield {
            type: 'progress',
            step,
            actionLog: [...actionLog],
            filesTouched: [...filesTouched]
          }
          yield {
            type: 'tool',
            tool: {
              id,
              name: call.name,
              path: result.path ?? path,
              status: result.ok ? 'ok' : 'error',
              effect: toolEffect,
              changedResources: toolEffect === 'read' || !result.path ? [] : [result.path],
              durationMs: Date.now() - toolStartedAt,
              failure: result.ok ? undefined : toolFailureMetadata(result.detail, toolEffect),
              detail: result.detail.slice(0, AGENT_HANDOFF_CHARS)
            }
          }
          // Short breadcrumb only — detail stays on the tool row, not a wall of thinking text.
          yield {
            type: 'thinking',
            text: `\n[${result.ok ? 'ok' : 'error'}] ${call.name}${
              result.path ? ` ${result.path}` : ''
            }\n`
          }
          resultParts.push(
            `TOOL_RESULT ${call.name}${result.path ? ` path=${result.path}` : ''}:\n${truncateForModel(result.detail)}` +
              (result.ok ? '' : `\nRECOVERY: ${toolFailureRecovery(call.name, result.detail)}`)
          )
        } finally {
          releaseWrite?.()
          workerMessages.push({
            role: 'tool',
            tool_call_id: call.id!,
            content:
              resultParts.slice(resultStart).join('\n') ||
              'Tool execution interrupted; no successful outcome was recorded.'
          })
        }
      }
      if (webLookup) {
        if (!webSearchText && webSearchNudges < 1) {
          webSearchNudges++
          yield {
            type: 'thinking',
            text: '\n\n— This needs a web search before an answer…\n'
          }
          workerMessages.push(webSearchNudge())
          yield emitSessionStep()
          continue
        }
        yield* answerFromWeb()
        return
      }

      if (onlyInspect) inspectRounds++

      if (mutatedThisRound) {
        noProgressStreak = 0
        yield { type: 'workspace-changed' }
      } else if (inspectedSourceThisRound) {
        noProgressStreak = 0
      } else if (!onlyInspect) {
        noProgressStreak++
      }

      // Verify periodically (not after every write) to avoid thrashing tsc/tests.
      // Never verify for .eris-only rounds (skills, rules, context).
      let verifyNote = ''
      if (codeMutatedThisRound) {
        mutationsSinceVerify++
        const shouldVerify =
          mutationsSinceVerify >= VERIFY_EVERY_N_MUTATIONS && verifyFailures < MAX_VERIFY_FAILURES
        if (shouldVerify) {
          workflow.transition('verifying')
          mutationsSinceVerify = 0
          yield { type: 'status', text: 'Verifying (typecheck/tests)…' }
          yield { type: 'thinking', text: '\n\n— Running verify (typecheck/tests)…\n' }
          // Mid-loop: typecheck-first, never npm install (keeps agent moving).
          const verified = await runVerify(executionRoot!, options.signal, {
            preferTypecheck: true,
            allowInstall: false
          })
          throwIfAborted(options.signal)
          appendToolObservation(
            workerMessages,
            'run',
            `VERIFY_RESULT (${verified.skipped ? 'skipped' : verified.ok ? 'passed' : 'failed'}):\n${verified.detail}`,
            { command: verified.command }
          )
          if (!verified.skipped) {
            yield { type: 'terminal', text: `$ ${verified.command}\n${verified.detail}\n` }
            yield {
              type: 'tool',
              tool: {
                id: `verify_${toolExecRounds}`,
                name: 'verify',
                status: verified.ok ? 'ok' : 'error',
                detail: verified.detail.slice(0, AGENT_HANDOFF_CHARS)
              }
            }
            verifyNote = `\n\nVerification ${verified.ok ? 'passed' : 'failed'}; full result recorded above.\n`
            if (!verified.ok) {
              workflow.noteVerification('failed')
              verifyFailures++
              const missingDeps = looksLikeMissingDeps(verified.detail)
              verifyNote += `Verify failed (${verifyFailures}/${MAX_VERIFY_FAILURES}). Fix with write_file/read_file.\n`
              if (missingDeps) {
                if (
                  installAttempts >= MAX_BARE_INSTALLS_PER_RUN &&
                  hasNodeModules(executionRoot!)
                ) {
                  verifyNote += `Missing-module errors: prefer npm install <package> or fix imports — avoid bare install loops.\n`
                } else {
                  verifyNote += `Missing-module errors: run npm install (or npm install <package>) in this workspace, then re-test.\n`
                }
              } else {
                verifyNote += `Do not run npm install for ordinary test/typecheck failures.\n`
              }
              actionLog.push(`Verify failed: ${verified.command}`)
              if (verifyFailures >= MAX_VERIFY_FAILURES) {
                const adapted = yield* tryMidRunAdapt('verify failures')
                if (adapted) {
                  verifyNote += `\nStaying on ${plan.agentName}. Continue fixing this failure yourself.\n`
                } else {
                  const answer =
                    buildWorkSummary(originalUserGoal, actionLog, '') +
                    `\n\nStopped: verify failed ${verifyFailures} times.\n` +
                    truncateForModel(verified.detail, AGENT_HANDOFF_CHARS)
                  yield {
                    type: 'thinking',
                    text: '\n\n— Verify failure budget exhausted; stopping.\n'
                  }
                  yield {
                    type: 'progress',
                    step,
                    actionLog: [...actionLog],
                    filesTouched: [...filesTouched],
                    incomplete: true
                  }
                  yield emitSessionStep('Stopped after verify failures')
                  yield { type: 'answer', text: answer, replace: true }
                  return
                }
              }
            } else {
              workflow.noteVerification('passed')
              verifyFailures = 0
              verifyPassedOnce = true
              actionLog.push(`Verify passed: ${verified.command}`)
            }
          }
          if (verified.skipped) {
            workflow.noteVerification('skipped')
            actionLog.push(`Verification skipped: ${verified.detail}`)
          }
          workflow.transition('executing')
        }
      }

      if (onlyInspect) {
        workerMessages.push({
          role: 'system',
          content:
            'Inspection results are recorded above. Read relevant sources if evidence is missing; otherwise answer the original request with paths.'
        })
      } else {
        const progress =
          filesTouched.length > 0
            ? `Files touched so far: ${[...new Set(filesTouched)].join(', ')}.\n`
            : ''
        workerMessages.push({
          role: 'system',
          content:
            `${verifyNote}\n\n${progress}` +
            (reviewOnly
              ? `If you still need evidence, emit read_file or run. ` +
                `If you can already confirm the review, reply with a DONE summary and no tools. ` +
                `Do not call tree/list_dir again.`
              : `If the user request is NOT fully done` +
                (verifyNote.includes('failed') ? ' or verify failed' : '') +
                `, emit the next write_file/mkdir/read_file tool JSON now. ` +
                `If it IS fully done` +
                (verifyNote && !verifyNote.includes('failed') ? ' and verify passed' : '') +
                `, reply with a short DONE summary and no tools. ` +
                `Do not call tree again unless the user asks for another listing.`)
        })
      }
      yield emitSessionStep()
    }
  } finally {
    releaseGgufSession()
  }
}
