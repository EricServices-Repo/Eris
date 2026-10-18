import { existsSync, readFileSync, statSync } from 'fs'
import { asksForRecommendations, asksWhatTheProjectDoes, needsWebLookup } from '../../../../src/shared/agent-contract'
import { isToolLogReply } from '../../../../src/shared/posted-answer'
import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { formatAvailableModelsPrompt } from '../model-catalog'
import {
  filterToolsByPolicy,
  isErisCapabilityQuestion,
  planChatTurn,
  toolAllowedByPolicy
} from '../chat-router'
import { callMcpTool, isMcpToolName, listMcpTools, syncMcpRuntime } from '../mcp-runtime'
import { retrieveContextAsync, workspaceGlob, workspaceGrep } from '../workspace-search'
import { findReferences, findSymbols, relatedFiles } from '../code-index'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  setContextSummary
} from '../workspace-context'
import { runVerify } from '../verify'
import type { OpenAIToolDef } from '../chat-runtime'
import { COMPOSER_OPENAI_TOOLS, mcpToolsToOpenAI, toolCallJsonSchema } from '../tool-registry'
import {
  createCheckpoint,
  getCheckpointOpCount,
  pruneOldCheckpoints,
  recordDeleteOp,
  recordMkdirOp,
  recordRenameOp,
  recordWriteOp,
  snapshotBeforeWrite
} from '../checkpoints'
import { runWorkspaceCommand } from '../shell-run'
import { applyUnifiedPatch, resolveInWorkspace, searchReplaceInFile } from '../workspace-fs'
import { gitCommit, gitDiff, gitStage, gitStatus, gitStash } from '../git-service'
import { pushPullFetch, parseGithubRepo } from '../github'
import { invalidateDiagnosticsCache } from '../diagnostics'
import { formatSkillsListForAgent, getSkill, slugifySkillId, upsertSkill } from '../skills'
import { userSkillsDir } from '../paths'
import {
  buildWorkSummary,
  compactAgentMessages,
  contextBudgetTokens,
  formatActionLogForResume,
  needsContextCompaction
} from './compaction'
import { executeTool } from './execute-tool'
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
import { shouldConsiderMidRunAdapt } from './mid-run-adapt'
import { findAgent } from '../agents'
import { AGENT_HANDOFF_CHARS, formatHandoffForPrompt } from '../../../../src/shared/agent-orchestration'
import { isVerifyCommand } from '../command-approval'
import { buildPreservedWorkerMessages, isReadOnlyChat, truncateForModel } from './prompts'
import {
  firstHttpsResult,
  replyFromWebEvidence,
  webSearchQuery
} from './web-grounding'
import { streamThinkingText } from './stream'
import { openWebPage, searchWeb } from '../web-search'
import {
  argString,
  parseToolCalls,
  postedAnswer,
  proseOutsideTools,
  stripToolBlocks,
  thinkingBeforeTools
} from './tool-parsing'
import { isNativeGgufRef, releaseLocalChatSession } from '../builtin-model'
import type { AgentChatMessage, AgentMode, AgentRunnerEvent, ToolCall } from './types'
import type { AgentHandoffPacket } from '../../../../src/shared/agent-orchestration'

/** Consecutive rounds with zero mutation → stronger finish nudge (never stops the run). */
const MAX_NO_PROGRESS = 8
/** Stop after this many failed verify rounds (mid-loop + final). */
const MAX_VERIFY_FAILURES = 3
/** Mid-loop verify cadence (final verify still runs once before DONE). */
const VERIFY_EVERY_N_MUTATIONS = 8
/** How many times we reject a premature DONE before stopping as incomplete. */
const MAX_GOAL_REJECTS = 3
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
  /**
   * Ask the user a clarifying question inline (~15s). Absent = auto-timeout / proceed.
   * Returns reply text, or null when timed out / skipped.
   */
  askUser?: (question: string, choices?: string[]) => Promise<string | null>
  /** Continue an interrupted run instead of starting fresh. */
  resume?: {
    goal: string
    actionLog: string[]
    filesTouched: string[]
    /** Restored mid-run transcript (session checkpoint). */
    workerMessages?: AgentChatMessage[]
    fromStep?: number
  }
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
    options.resume?.goal ||
    [...messages].reverse().find((m) => m.role === 'user')?.content.replace(/\n\n\[Eris\][\s\S]*$/, '') ||
    ''

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

  yield { type: 'status', text: plan.reason }
  if (plan.error) {
    yield { type: 'answer', text: plan.error, replace: true }
    return
  }

  const chatModel = plan.models.chat
  let workerModel = plan.models.tools
  const modelsCatalog = formatAvailableModelsPrompt(options.settings, chatModel)
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
    mode === 'ask' ||
    plan.intent === 'capability' ||
    (!webQuestion &&
      !forceWorkspaceTools &&
      (!plan.requiresTools ||
        plan.toolPolicy === 'none' ||
        !options.workspacePath ||
        plan.intent === 'answer'))

  if (answerOnly) {
    yield { type: 'model', model: chatModel }
    yield {
      type: 'status',
      text:
        plan.intent === 'capability'
          ? 'Answering from model catalog…'
          : mode === 'ask'
            ? `Ask · ${plan.agentName}…`
            : `${plan.agentName}…`
    }
    const askMessages = messages.map((m) => ({ ...m }))
    const tips: string[] = [modelsCatalog, `Routing: ${plan.reason}`]
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
    const tip = tips.join('\n\n')
    const idx = askMessages.findIndex((m) => m.role === 'system')
    if (idx >= 0) {
      askMessages[idx] = {
        role: 'system',
        content: `${askMessages[idx].content}\n\n${tip}`
      }
    } else {
      askMessages.unshift({ role: 'system', content: tip })
    }
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
  yield {
    type: 'status',
    text: `${plan.agentName} · ${plan.intent} · ${workerModel.replace(/^builtin:/, '')}…`
  }
  yield { type: 'model', model: workerModel }
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

  const mcpSyncP =
    mcpMode === 'sync'
      ? syncMcpRuntime(options.settings, workspacePath).catch(() => undefined)
      : Promise.resolve()
  const retrieveP = retrieveContextAsync(workspacePath, originalUserGoal, 6).catch(() => null)

  const checkpoint = createCheckpoint(workspacePath)
  pruneOldCheckpoints(workspacePath, 20)
  yield { type: 'checkpoint', checkpointId: checkpoint.id }

  const [, retrieved] = await Promise.all([mcpSyncP, retrieveP])
  const mcpTools = mcpMode === 'off' ? [] : listMcpTools()

  let retrievalHint = ''
  if (retrieved && retrieved.paths.length > 0) {
    retrievalHint =
      `\n\n[Eris retrieval — likely relevant files]\n${retrieved.paths.map((p) => `- ${p}`).join('\n')}`
  }
  const mcpToolCount = mcpTools.length
  const openaiTools: OpenAIToolDef[] = filterToolsByPolicy(
    [
      ...COMPOSER_OPENAI_TOOLS,
      ...mcpToolsToOpenAI(
        mcpTools.map((t) => ({
          fqName: t.fqName,
          description: t.description
        }))
      )
    ],
    plan.toolPolicy
  )
  if (plan.agentId === 'reviewer' && !openaiTools.some((t) => t.function.name === 'run')) {
    const runTool = COMPOSER_OPENAI_TOOLS.find((t) => t.function.name === 'run')
    if (runTool) openaiTools.push(runTool)
  }
  const resumedWorker = options.resume?.workerMessages
  const workerMessages: AgentChatMessage[] =
    resumedWorker && resumedWorker.length > 0
      ? resumedWorker.map((m) => ({ role: m.role, content: m.content }))
      : buildPreservedWorkerMessages({
          messages,
          workspacePath,
          settings: options.settings,
          plan,
          originalUserGoal,
          retrievalHint,
          mcpToolCount
        })

  let lastTreeResult: string | null = null
  let lastInspectResult: string | null = null
  let workspaceMutated = false
  /** True only when product source (not .eris skills/rules/context) changed. */
  let codeMutated = false
  /** Cap inline clarifying prompts so a run cannot stall forever. */
  let askUserCount = 0
  const MAX_ASK_USER = 2
  const filesTouched: string[] = [...(options.resume?.filesTouched ?? [])]
  const actionLog: string[] = [...(options.resume?.actionLog ?? [])]
  if (options.resume) {
    const fromStep = options.resume.fromStep
    if (resumedWorker && resumedWorker.length > 0) {
      workerMessages.push({
        role: 'user',
        content:
          `[Eris] Resuming from session checkpoint` +
          (fromStep != null ? ` (step ${fromStep})` : '') +
          `. Continue with tools; do not restart from scratch.`
      })
      yield {
        type: 'thinking',
        text: `\n\n— Resuming session${fromStep != null ? ` from step ${fromStep}` : ''} (${actionLog.length} prior actions)…\n`
      }
    } else {
      const lastUser = [...workerMessages].reverse().find((m) => m.role === 'user')
      const note =
        `\n\n[Resuming an interrupted task]\nAlready done before the interruption:\n` +
        `${formatActionLogForResume(actionLog, 30)}\n` +
        (filesTouched.length ? `Files touched: ${[...new Set(filesTouched)].join(', ')}\n` : '') +
        `Re-read files you need, skip completed steps, and continue from where it stopped.`
      if (lastUser) lastUser.content += note
      else workerMessages.push({ role: 'user', content: note.trim() })
      yield { type: 'thinking', text: `\n\n— Resuming (${actionLog.length} prior actions)…\n` }
    }
  }
  /** Rolling Lite-written memory folded across comped. */
  let contextMemory: string | null = null
  /** At most one dependency install per agent run. */
  let installAttempts = 0
  let noProgressStreak = 0
  let lastFingerprint = ''
  let repeatFingerprint = 0
  let toolExecRounds = 0
  let inspectRounds = 0
  let step = 0
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
      workerMessages: workerMessages.map((m) => ({ role: m.role, content: m.content }))
    }
  }
  let mutationsSinceVerify = 0
  let consecutiveToolErrors = 0
  let goalRejectCount = 0
  let verifyPassedOnce = false
  let escalateCount = plan.escalateToFull ? 1 : 0
  let rerouteCount = 0
  const reviewOnly = plan.intent === 'review' || isReviewOnlyGoal(originalUserGoal)
  const listImprovements = asksForRecommendations(originalUserGoal)
  const describeProject = asksWhatTheProjectDoes(originalUserGoal)
  const webLookup = webQuestion
  let webSearchNudges = 0
  let webSearchText = ''
  let webPageText = ''
  const chatReply = describeProject || isReadOnlyChat(plan)
  const describeProjectNext =
    `Read README, package.json, or the main source. Do not stop after .eris config. ` +
    `Do not write or edit files. ` +
    `Then reply with no tools: what this project is, what it does, and the important files, citing paths.`
  const chatReplyNext = listImprovements
    ? `Do not edit files. Read the project sources, then list the improvements as a numbered list and cite paths. Do not implement them.`
    : `Do not edit files. Read the sources that answer the user, then reply in plain sentences and cite paths.`
  const answerNext = describeProject ? describeProjectNext : chatReply ? chatReplyNext : ''
  const sourceReads: Array<{ path: string; text: string }> = []
  let promptBudget = contextBudgetTokens(options.settings, workerModel)

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
  const toolCallSchema = toolCallJsonSchema(mcpTools.map((t) => t.fqName))
  let constrainNextToolCall = false

  async function* tryMidRunAdapt(trigger: string): AsyncGenerator<AgentRunnerEvent, boolean, unknown> {
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
    // Stay on the agent the user was shown. A stuck step is reported, not reassigned.
    rerouteCount = 2
    const reason = `${plan.agentName} stays on this turn. ${trigger}.`
    consecutiveToolErrors = 0
    noProgressStreak = 0
    verifyFailures = Math.max(0, verifyFailures - 1)
    yield { type: 'status', text: reason }
    yield { type: 'thinking', text: `\n\n— ${reason}\n` }
    workerMessages.push({
      role: 'user',
      content:
        `[Eris] ${reason}\n` +
        `Do not switch roles. Say what failed, then take the next step as ${plan.agentName}.`
    })
    return true
  }

  async function* compactWorkerContext(opts: {
    force?: boolean
    skipLiteSummary?: boolean
  } = {}): AsyncGenerator<AgentRunnerEvent, void, unknown> {
    if (
      !needsContextCompaction(workerMessages, promptBudget, Boolean(opts.force))
    ) {
      return
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
    role: 'user',
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

  const nudgeAfterInspect = (snapshot: string): AgentChatMessage => ({
    role: 'user',
    content:
      `TOOL_RESULT (listing already in context):\n${truncateForModel(snapshot, AGENT_HANDOFF_CHARS)}\n\n` +
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
    role: 'user',
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
    role: 'user',
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
          tool: { id, name: 'web_search', status: 'ok', detail: webSearchText.slice(0, AGENT_HANDOFF_CHARS) }
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
    if (!webPageText) {
      const url = firstHttpsResult(webSearchText)
      if (url) {
        yield { type: 'status', text: 'Opening the first result…' }
        yield { type: 'thinking', text: `\n\n— Opening ${url}…\n` }
        const id = 'web_auto_open'
        yield {
          type: 'tool',
          tool: { id, name: 'web_open', path: url, status: 'running', detail: url }
        }
        try {
          webPageText = await openWebPage(url, options.signal)
          actionLog.push(webPageText.split('\n')[0]!.slice(0, 160))
          yield {
            type: 'tool',
            tool: {
              id,
              name: 'web_open',
              path: url,
              status: 'ok',
              detail: webPageText.slice(0, AGENT_HANDOFF_CHARS)
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
  async function* finishChatAnswer(latest: string): AsyncGenerator<AgentRunnerEvent, void, unknown> {
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
      role: 'user',
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
    for await (const evt of streamThinkingText({
      ...options,
      model: workerModel,
      messages: workerMessages,
      stopOnToolCall: true,
      tools: openaiTools,
      builtinJsonSchema: constrainThisTurn ? toolCallSchema : undefined,
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

    if (
      chatReply &&
      toolCalls.length > 0 &&
      toolCalls.every(
        (call) => !toolAllowedByPolicy(call.name, 'read') && call.name !== 'run'
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
      workerMessages.push({ role: 'user', content: answerNext || chatReplyNext })
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
          text: '\n\n— Skipping user ask — listing the workspace with tools…\n'
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
        workerMessages.push({
          role: 'user',
          content:
            `TOOL_RESULT tree path=.\n${truncateForModel(treeResult.detail, AGENT_HANDOFF_CHARS)}\n\n` +
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
        workerMessages.push({ role: 'assistant', content: clarifyText.slice(0, AGENT_HANDOFF_CHARS) })
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
            text: '\n\n— No reply (15s) — continuing with best judgment…\n'
          }
          workerMessages.push({
            role: 'user',
            content:
              `The user did not reply within 15 seconds. Proceed with the original request ` +
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
          workerMessages.push({ role: 'assistant', content: assistantText.slice(0, AGENT_HANDOFF_CHARS) })
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
        yield { type: 'status', text: 'Final verify…' }
        const finalVerify = await runVerify(workspacePath, options.signal, {
          preferTypecheck: false,
          allowInstall: true,
          approveInstall: options.approveCommand
            ? (cmd) => options.approveCommand!('run', cmd)
            : undefined
        })
        if (!finalVerify.skipped && !finalVerify.ok) {
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
            yield { type: 'progress', step, actionLog: [...actionLog], filesTouched: [...filesTouched], incomplete: true }
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
            ? installAttempts >= MAX_BARE_INSTALLS_PER_RUN && hasNodeModules(workspacePath)
              ? ` Do NOT run bare npm install again — use npm install <package> for a missing dep, or fix imports.`
              : ` Missing modules: run npm install (or npm install <package>) in this workspace, then re-test.`
            : ` Do not run npm install for ordinary failures.`
          workerMessages.push({
            role: 'user',
            content:
              `VERIFY_RESULT (failed):\n${truncateForModel(finalVerify.detail, 8000)}\n\n` +
              `You are NOT done. Fix these errors with write_file/read_file tools now.` +
              installHint
          })
          continue
        }
        if (!finalVerify.skipped && finalVerify.ok) {
          verifyPassedOnce = true
          actionLog.push(`Verify passed: ${finalVerify.command}`)
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
      if (goalCheck.unmet) {
        goalRejectCount++
        constrainNextToolCall = true
        yield {
          type: 'thinking',
          text: `\n\n— Goal check failed (${goalRejectCount}/${MAX_GOAL_REJECTS}): ${goalCheck.reason}\n`
        }
        if (goalRejectCount >= MAX_GOAL_REJECTS) {
          const workerNote = stripToolBlocks(assistantText).trim()
          const answer =
            buildWorkSummary(originalUserGoal, actionLog, workerNote) +
            `\n\nIncomplete: ${goalCheck.reason}`
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
          role: 'user',
          content:
            `GOAL_CHECK_FAILED:\n${goalCheck.reason}\n\n` +
            `You are NOT finished. Continue with tools (write_file / search_replace / run / verify) ` +
            `until the original request is truly satisfied. Do not claim DONE yet.\n` +
            `User request:\n${originalUserGoal.slice(0, AGENT_HANDOFF_CHARS)}`
        })
        yield { type: 'status', text: `${plan.agentName} · goal unmet — continuing…` }
        continue
      }

      // Deterministic summary — never unload Full to reload Lite just for a recap.
      const prose = proseOutsideTools(assistantText)
      if (webLookup) {
        yield* answerFromWeb()
        return
      }
      if (prose.length >= 40 && !isToolLogReply(prose)) {
        yield { type: 'status', text: 'Done' }
        yield { type: 'answer', text: prose, replace: true }
        return
      }
      yield* finishChatAnswer(assistantText)
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
      workerMessages.push({ role: 'assistant', content: assistantText.slice(0, AGENT_HANDOFF_CHARS) })
      // After two skip cycles on review tasks, allow DONE without more tools
      if (reviewOnly && noProgressStreak >= 2) {
        workerMessages.push({
          role: 'user',
          content:
            `TOOL_RESULT (cached):\n${truncateForModel(snapshot, AGENT_HANDOFF_CHARS)}\n\n` +
            `Stop calling tree/list_dir. Either emit ONE read_file or run tool, ` +
            `OR reply with a DONE summary of whether the calculator app looks working — no tools.`
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

    if (repeatFingerprint >= 4 && !onlyInspect) {
      noProgressStreak++
      yield {
        type: 'thinking',
        text: chatReply
          ? '\n\n— Same tool call repeated; answer the user from the files already read…\n'
          : '\n\n— Same tool call repeated; moving on to the next unfinished edit…\n'
      }
      workerMessages.push({ role: 'assistant', content: assistantText.slice(0, AGENT_HANDOFF_CHARS) })
      workerMessages.push(
        nudgeContinueWork(
          'You repeated the same tool call. Move on to the next unfinished part of the request.'
        )
      )
      repeatFingerprint = 0
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

    toolExecRounds++
    yield {
      type: 'thinking',
      text: `\n\n— Running ${toolCalls.length} workspace tool${toolCalls.length === 1 ? '' : 's'}…\n`
    }

    workerMessages.push({ role: 'assistant', content: assistantText })

    const resultParts: string[] = []
    let mutatedThisRound = false
    let codeMutatedThisRound = false
    for (let i = 0; i < toolCalls.length; i++) {
      throwIfAborted(options.signal)
      const call = toolCalls[i]
      const id = `t${toolExecRounds}_${i}`
      const reviewerRun = call.name === 'run' && plan.agentId === 'reviewer'
      if (reviewerRun && !isVerifyCommand(argString(call.args, 'command'))) {
        yield {
          type: 'tool',
          tool: {
            id,
            name: call.name,
            status: 'error',
            detail: 'Reviewer can only run tests or typecheck'
          }
        }
        resultParts.push(
          'TOOL_RESULT run: blocked. Reviewer may only run tests or typecheck (npm test, npx tsc, pytest, cargo test).'
        )
        continue
      }
      if (!toolAllowedByPolicy(call.name, plan.toolPolicy) && !reviewerRun) {
        yield {
          type: 'tool',
          tool: {
            id,
            name: call.name,
            status: 'error',
            detail: `Blocked by tool policy (${plan.toolPolicy}) for agent ${plan.agentName}`
          }
        }
        resultParts.push(
          `TOOL_RESULT ${call.name}: blocked by policy ${plan.toolPolicy}`
        )
        continue
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
      yield {
        type: 'tool',
        tool: { id, name: call.name, path, status: 'running', detail: 'Running…' }
      }

      let result: { ok: boolean; detail: string; mutated: boolean; path?: string }

      const approvalCommand =
        call.name === 'run'
          ? argString(call.args, 'command')
          : call.name === 'git_sync' && argString(call.args, 'action', 'pull') === 'push'
            ? 'git push'
            : ''
      let approvalDenied = false
      if (approvalCommand && options.approveCommand && !isGlobalInstallCommand(approvalCommand)) {
        yield {
          type: 'status',
          text: `Waiting for approval: ${approvalCommand.slice(0, 80)}`
        }
        approvalDenied = !(await options.approveCommand(
          call.name === 'run' ? 'run' : 'push',
          approvalCommand
        ))
      }

      if (approvalDenied) {
        result = {
          ok: false,
          detail:
            `The user denied running \`${approvalCommand}\`. Do not retry it. ` +
            'Continue without it, or explain what the user should run themselves.',
          mutated: false
        }
        yield { type: 'thinking', text: `\n\n— Command denied by user: ${approvalCommand}\n` }
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
          const modulesPresent = hasNodeModules(workspacePath)
          const pkgNewer = packageJsonNewerThanModules(workspacePath)
          // Allow workspace installs freely; only stop bare reinstall loops.
          const needsInstall = !modulesPresent || pkgNewer
          const blockBareLoop =
            !addingPackage &&
            !needsInstall &&
            installAttempts >= MAX_BARE_INSTALLS_PER_RUN

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
            const ran = await runWorkspaceCommand(workspacePath, command, {
              signal: options.signal,
              timeoutMs: 300_000
            })
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
          const ran = await runWorkspaceCommand(workspacePath, command, {
            signal: options.signal
          })
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
          if (!webPageText) webPageText = detail
        } catch (err) {
          result = {
            ok: false,
            detail: err instanceof Error ? err.message : 'Could not open the page',
            mutated: false,
            path: url
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
        const found = findSymbols(workspacePath, query)
        result = { ok: found.ok, detail: found.detail, mutated: false }
      } else if (call.name === 'find_references') {
        const name =
          argString(call.args, 'name') || argString(call.args, 'query') || argString(call.args, 'symbol')
        const found = findReferences(workspacePath, name)
        result = { ok: found.ok, detail: found.detail, mutated: false }
      } else if (call.name === 'semantic_search') {
        const query =
          argString(call.args, 'query') || argString(call.args, 'pattern') || originalUserGoal
        const retrieved = await retrieveContextAsync(workspacePath, query, 8)
        result = { ok: retrieved.ok, detail: retrieved.detail, mutated: false }
      } else if (call.name === 'related_files') {
        const path = argString(call.args, 'path') || argString(call.args, 'file')
        const related = relatedFiles(workspacePath, path)
        result = { ok: related.ok, detail: related.detail, mutated: false }
      } else if (call.name === 'retrieve') {
        const query =
          argString(call.args, 'query') || argString(call.args, 'pattern') || originalUserGoal
        const retrieved = await retrieveContextAsync(workspacePath, query, 8)
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
          ? call.args.choices.map((c) => String(c)).filter(Boolean).slice(0, 6)
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
                'User did not reply within 15 seconds. Proceed with the original request using your best judgment. Do not ask another clarifying question unless you are blocked.',
              mutated: false
            }
            yield {
              type: 'thinking',
              text: '\n\n— No reply (15s) — continuing with best judgment…\n'
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
            detail: 'A specialist does not delegate further. Finish the assigned goal yourself.',
            mutated: false
          }
        } else if (options.jobId?.startsWith('chat:')) {
          const specialist = findAgent(workspacePath, agentId)
          const specialistPlan = await planChatTurn({
            workspacePath,
            settings: options.settings,
            context: {
              text: goal,
              selectedModel: workerModel,
              mode: 'agent',
              manualAgentId: agentId,
              forceRoute: 'tools'
            },
            getSecret: options.getSecret,
            signal: options.signal
          })
          specialistPlan.models = {
            ...specialistPlan.models,
            chat: workerModel,
            tools: workerModel
          }
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
          const specTools: Array<{ name: string; path?: string; status: string }> = []
          try {
            for await (const specEvt of runAgentWithWorkspaceTools({
              workspacePath,
              settings: options.settings,
              model: workerModel,
              messages: [
                {
                  role: 'user',
                  content: `${formatHandoffForPrompt(handoff)}\n\n${goal}`
                }
              ],
              temperature: specialist?.temperature ?? options.temperature,
              signal: options.signal,
              getSecret: options.getSecret,
              mode: 'agent',
              turnPlan: specialistPlan,
              approveCommand: options.approveCommand,
              askUser: options.askUser,
              mcp: 'reuse',
              jobId: `${options.jobId}:inline:${agentId}`,
              allowDelegate: false
            })) {
              if (
                specEvt.type === 'thinking' ||
                specEvt.type === 'tool' ||
                specEvt.type === 'diff' ||
                specEvt.type === 'status' ||
                specEvt.type === 'workspace-changed' ||
                specEvt.type === 'checkpoint' ||
                specEvt.type === 'terminal'
              ) {
                yield specEvt
              }
              if (specEvt.type === 'answer') answer += specEvt.text
              if (specEvt.type === 'tool' && specEvt.tool.status !== 'running') {
                specTools.push({
                  name: specEvt.tool.name,
                  path: specEvt.tool.path,
                  status: specEvt.tool.status
                })
              }
            }
            result = {
              ok: true,
              detail: answer.trim() || `${runningDelegation.agentName} finished.`,
              mutated: specTools.some((t) => t.status === 'ok')
            }
            yield {
              type: 'delegation',
              delegation: {
                ...runningDelegation,
                status: 'done',
                tools: specTools.slice(-6),
                result: result.detail.slice(0, AGENT_HANDOFF_CHARS)
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            result = { ok: false, detail: message, mutated: false }
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
            if (options.onAwaitChildren) {
              yield { type: 'status', text: `Waiting for ${agentId}…` }
              const awaited = await options.onAwaitChildren(
                typeof call.args.timeout_ms === 'number' ? call.args.timeout_ms : 600_000
              )
              result = {
                ok: awaited.ok,
                detail: `${delegated.detail}\n\n${awaited.detail}`,
                mutated: false
              }
            }
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
      } else if (mcpMode !== 'off' && isMcpToolName(call.name)) {
        const mcpResult = await callMcpTool(call.name, call.args)
        result = { ok: mcpResult.ok, detail: mcpResult.detail, mutated: false }
      } else if (
        call.name === 'write_file' ||
        call.name === 'search_replace' ||
        call.name === 'apply_patch'
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
            const oldString = argString(call.args, 'old_string') || argString(call.args, 'oldString')
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
          | 'push'
          | 'pop'
          | 'list'
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
          | 'fetch'
          | 'pull'
          | 'push'
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
          const rec = recordDeleteOp(workspacePath, checkpoint.id, delPath, before, wasDirectory)
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
        if (result.ok && mkdirPath) {
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
        if (result.path) filesTouched.push(result.path)
        if (pathNeedsProjectVerify(result.path)) {
          codeMutated = true
          codeMutatedThisRound = true
        }
      }
      if (result.ok) {
        if (
          call.name === 'read_file' &&
          result.path &&
          !result.path.replace(/\\/g, '/').startsWith('.eris/')
        ) {
          sourceReads.push({ path: result.path, text: result.detail.slice(0, AGENT_HANDOFF_CHARS) })
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
        actionLog.push(`Failed ${call.name}${path ? ` ${path}` : ''}: ${result.detail.slice(0, AGENT_HANDOFF_CHARS)}`)
      }
      yield { type: 'progress', step, actionLog: [...actionLog], filesTouched: [...filesTouched] }
      yield {
        type: 'tool',
        tool: {
          id,
          name: call.name,
          path: result.path ?? path,
          status: result.ok ? 'ok' : 'error',
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
        `TOOL_RESULT ${call.name}${result.path ? ` path=${result.path}` : ''}:\n${truncateForModel(result.detail)}`
      )
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
    } else if (!onlyInspect) {
      noProgressStreak++
    }

    // Verify periodically (not after every write) to avoid thrashing tsc/tests.
    // Never verify for .eris-only rounds (skills, rules, context).
    let verifyNote = ''
    if (codeMutatedThisRound) {
      mutationsSinceVerify++
      const shouldVerify =
        mutationsSinceVerify >= VERIFY_EVERY_N_MUTATIONS &&
        verifyFailures < MAX_VERIFY_FAILURES
      if (shouldVerify) {
        mutationsSinceVerify = 0
        yield { type: 'status', text: 'Verifying (typecheck/tests)…' }
        yield { type: 'thinking', text: '\n\n— Running verify (typecheck/tests)…\n' }
        // Mid-loop: typecheck-first, never npm install (keeps agent moving).
        const verified = await runVerify(workspacePath, options.signal, {
          preferTypecheck: true,
          allowInstall: false
        })
        throwIfAborted(options.signal)
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
          verifyNote = `\n\nVERIFY_RESULT (${verified.ok ? 'passed' : 'failed'}):\n${truncateForModel(verified.detail, 8000)}\n`
          if (!verified.ok) {
            verifyFailures++
            const missingDeps = looksLikeMissingDeps(verified.detail)
            verifyNote +=
              `Verify failed (${verifyFailures}/${MAX_VERIFY_FAILURES}). Fix with write_file/read_file.\n`
            if (missingDeps) {
              if (installAttempts >= MAX_BARE_INSTALLS_PER_RUN && hasNodeModules(workspacePath)) {
                verifyNote +=
                  `Missing-module errors: prefer npm install <package> or fix imports — avoid bare install loops.\n`
              } else {
                verifyNote +=
                  `Missing-module errors: run npm install (or npm install <package>) in this workspace, then re-test.\n`
              }
            } else {
              verifyNote += `Do not run npm install for ordinary test/typecheck failures.\n`
            }
            actionLog.push(`Verify failed: ${verified.command}`)
            if (verifyFailures >= MAX_VERIFY_FAILURES) {
              const adapted = yield* tryMidRunAdapt('verify failures')
              if (adapted) {
                verifyNote +=
                  `\nStaying on ${plan.agentName}. Continue fixing this failure yourself.\n`
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
            verifyFailures = 0
            verifyPassedOnce = true
            actionLog.push(`Verify passed: ${verified.command}`)
          }
        }
      }
    }

    if (onlyInspect) {
      const snap = lastInspectResult || lastTreeResult || resultParts.join('\n\n')
      workerMessages.push(nudgeAfterInspect(snap))
    } else {
      const progress =
        filesTouched.length > 0
          ? `Files touched so far: ${[...new Set(filesTouched)].join(', ')}.\n`
          : ''
      workerMessages.push({
        role: 'user',
        content:
          `${resultParts.join('\n\n')}${verifyNote}\n\n${progress}` +
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
