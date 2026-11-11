import { createContextOrigin } from '../services/context-origin'
import { chooseExecutionModel } from '../services/auto-model-policy'
import { ThreadWorkingStateBuilder } from '../services/thread-working-state'
import { pendingCommandApprovals } from '../services/command-approval'
import { captureReceiptEvidence } from '../services/context-evidence'
import { pendingUserQuestions } from '../services/user-question'
import { chatPublisher, replayChatJob } from '../services/chat-events'
import {
  parseChatSubmission,
  submissionDigest,
  validateSubmissionPaths
} from '../services/chat-submission'
import { foregroundTasks } from '../services/foreground-tasks'
import { getChat, appendChatMessage, scopeChatSource } from '../services/chats'
import { compactHistory } from '../services/chat-prompt'
import { contextBudgetTokens, prepareContextBudget } from '../services/agent/context-budget'
import {
  allocateContext,
  historyChars,
  type ContextAllocation
} from '../../../src/shared/context-allocation'
import { conversationContext } from '../services/context-memory'
import { inEvidenceScope, leaseMemoryEvidence } from '../services/memory-dispatch'
import { appendTaskEvent } from '../services/task-ledger'
import type { MemoryPrompt } from '../../../src/shared/context-memory'
import { flushTaskLedger } from '../services/task-ledger'
import { reviewTaskOutcome } from '../services/task-outcome'
import { asksForImageGeneration } from '../../../src/shared/image-generation'
import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { turnPlanToRouteResult } from '../services/chat-router'
import {
  buildChatTurnMessages,
  localChatTurnModel,
  needsOutcomeReview,
  OutcomeEvidence,
  planInitialChatTurn,
  resolveChatTurnContract,
  completeChatTurnTask,
  type ChatTurnInput
} from '../services/chat-turn'
import {
  commandNeedsApproval,
  denyAllPendingApprovals,
  formatMcpApprovalPreview,
  normalizeCommand,
  requestCommandApproval,
  resolveCommandApproval,
  type CommandApprovalDecision
} from '../services/command-approval'
import {
  cancelAllPendingQuestions,
  requestUserQuestion,
  resolveUserQuestion,
  USER_QUESTION_TIMEOUT_MS
} from '../services/user-question'
import { finalizePostedAnswer, REVIEWER_UNAVAILABLE } from '../../../src/shared/posted-answer'
import { taskIntakeBlocked } from '../../../src/shared/task-contract'
import type { ChatMessage, ChatDelegation, TurnPlan } from '../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS, summarizeAgentResults } from '../../../src/shared/agent-orchestration'
import { saveTask } from '../services/task-store'
import { saveAgentRun, type AgentRunRecord } from '../services/agent-runs'
import {
  appendSessionStep,
  createAgentSession,
  listSessionSteps,
  loadAgentSession,
  setAgentSessionStatus
} from '../services/agent-sessions'
import { runAgentWithWorkspaceTools } from '../services/agent-runner'
import {
  configureBackgroundAgents,
  delegateFromAgent,
  getBackgroundJob
} from '../services/background-agents'
import { setDiagnosticsPaused } from '../services/diagnostics'
import { findAgent } from '../services/agents'
import { appState } from '../app-state'
import { getSecret, abortAllCompletes } from './shared'
import { addWorkspaceAllowedCommand, workspaceAllowedCommands } from '../services/workspace-trust'
import { assertChatWithinPlan, assertCloudJobWithinPlan } from '../services/eris-entitlements'
import { logError, logInfo, logWarn } from '../services/logger'
import { recordAgentRun } from '../services/agent-telemetry'
import { cloudInlineAvailable, runCloudAgentInline } from '../services/cloud-agent-inline'
import { rememberAgentRun, rememberAskUserReply } from '../services/project-memory'
import {
  finishChatJob,
  getLatestChatJob,
  admitChatJob,
  markChatJobRunning,
  isChatJobTerminal
} from '../services/chat-job-controller'

/** Routing and task intake read this much recent history, whatever the window. */
const ROUTING_HISTORY_MESSAGES = 20

export function registerChatStreamIpc(): void {
  ipcMain.handle('chat:stream', async (event, raw: unknown) => {
    let payload
    const workspacePath = appState.currentWorkspace
    try {
      if (appState.mainWindow && event.sender !== appState.mainWindow.webContents)
        throw new Error('Chat submissions must come from the application window.')
      if (event.senderFrame?.top && event.senderFrame !== event.senderFrame.top)
        throw new Error('Chat submissions must come from the main application frame.')
      payload = parseChatSubmission(raw)
      validateSubmissionPaths(payload, workspacePath)
      const threadId = payload.threadId ?? payload.prompt?.threadId
      if (threadId && !(await getChat(workspacePath, threadId, { limit: 1 })))
        throw new Error('The chat thread does not belong to the selected workspace.')
    } catch (error) {
      const id =
        raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string'
          ? raw.requestId.slice(0, 128)
          : null
      event.sender.send('chat:error', {
        requestId: id,
        error:
          'Invalid chat submission: ' +
          (error instanceof Error ? error.message : 'invalid payload'),
        code: 'INVALID_SUBMISSION'
      })
      return false
    }
    const userText =
      payload.prompt?.text ||
      [...(payload.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ||
      ''
    try {
      const admission = await admitChatJob({
        id: payload.requestId,
        workspacePath,
        threadId: payload.threadId ?? payload.prompt?.threadId ?? null,
        goal: userText,
        submissionDigest: submissionDigest(payload, workspacePath)
      })
      event.sender.send('chat:accepted', {
        requestId: payload.requestId,
        cursor: admission.job.cursor ?? 0,
        status: admission.job.status
      })
      if (admission.duplicate) {
        replayChatJob(admission.job, event.sender)
        return true
      }
    } catch (error) {
      event.sender.send('chat:error', {
        requestId: payload.requestId,
        error: error instanceof Error ? error.message : 'Task admission failed',
        code: 'ADMISSION_FAILED'
      })
      return false
    }
    try {
      const run = inEvidenceScope(async (controller: AbortController) => {
        if (workspacePath !== appState.currentWorkspace)
          throw new Error('The workspace changed while this task was queued.')
        markChatJobRunning(payload.requestId)
        let releaseMemoryEvidence = (): void => undefined
        try {
          const requestReceivedAt = Date.now()
          // Renderer planning happens before this IPC request; fallback planning below
          // is already included in the elapsed IPC time.
          const externalPlanningDurationMs = payload.planningDurationMs || 0
          const settings = getResolvedSettings(workspacePath)
          const { requestId } = payload
          const chatSender = () => {
            const current = appState.mainWindow?.webContents
            return current && !current.isDestroyed() ? current : event.sender
          }
          const publishEvent = chatPublisher(requestId, chatSender)
          let visibleAnswer = ''
          let visibleThinking = ''
          const replyAssets: NonNullable<ChatMessage['assets']> = []
          const replyDelegations = new Map<string, ChatDelegation>()
          let replyModel = payload.model
          let replyAgentId = payload.agentId
          let replyAgentName: string | undefined
          const publish = (channel: string, data: Record<string, unknown>) => {
            if (channel === 'chat:thinking' && typeof data.chunk === 'string')
              visibleThinking += data.chunk
            if (channel === 'chat:asset' && data.asset) {
              const asset = data.asset as NonNullable<ChatMessage['assets']>[number]
              if (!replyAssets.some((item) => item.id === asset.id)) replyAssets.push(asset)
            }
            if (channel === 'chat:delegation' && data.delegation) {
              const delegation = data.delegation as ChatDelegation
              replyDelegations.set(delegation.id, delegation)
            }
            if (channel === 'chat:model') {
              if (typeof data.model === 'string') replyModel = data.model
              if (typeof data.agentId === 'string') replyAgentId = data.agentId
              if (typeof data.agentName === 'string') replyAgentName = data.agentName
            }
            if (channel === 'chat:answer' && typeof data.chunk === 'string')
              visibleAnswer = data.replace ? data.chunk : visibleAnswer + data.chunk
            publishEvent(channel, data)
          }
          const contextThreadId = payload.threadId ?? payload.prompt?.threadId
          let conversationMemory: MemoryPrompt | undefined
          let workingState: ThreadWorkingStateBuilder | undefined
          let completionEvidence: import('../../../src/shared/task-contract').TaskCompletionEvidence | undefined
          let replySnapshot: ChatMessage | undefined
          const persistReply = async (terminal: string) => {
            if (!contextThreadId) return true
            const { content, thinking } = finalizePostedAnswer(
              visibleAnswer,
              visibleThinking,
              terminal === 'stopped',
              replyAssets.length > 0
            )
            if (!content && !replyAssets.length) return true
            replySnapshot = {
              id: `${requestId}:assistant`,role:'assistant',content,thinking:thinking || undefined,
              assets:replyAssets.length ? [...replyAssets] : undefined,
              delegations:replyDelegations.size ? [...replyDelegations.values()] : undefined,
              createdAt:Date.now(),model:replyModel,agentId:replyAgentId ?? turnPlan?.agentId,agentName:replyAgentName,
              contextResult:{completion:completionEvidence,workingState:workingState?.snapshot(terminal),
                taskId:requestId,terminal,projectRoot:turnPlan?.task?.scope.projectRoot ?? null,
                changedFiles:memoryFiles.slice(0,200)}
            }
            try {
              const selectedPaths = [...new Set([...evidencePaths, ...memoryFiles])]
              let dependencies =
                workspacePath && (selectedPaths.length || observedCheck)
                  ? await captureReceiptEvidence(workspacePath, selectedPaths)
                  : undefined
              if (dependencies && !selectedPaths.length)
                dependencies = { ...dependencies, complete: false }
              replySnapshot.contextResult = {...replySnapshot.contextResult!,dependencies}
              const saved = await appendChatMessage(workspacePath, contextThreadId, replySnapshot)
              replySnapshot = saved.messages.find(message => message.id === replySnapshot!.id) ?? replySnapshot
              return true
            } catch (error) {
              replySnapshot.contextResult!.completion = {
                ...(completionEvidence ?? {execution:'incomplete',verification:'not-run',assessment:{status:'not-run'}}),
                persistence:'failed'
              }
              publish('chat:error', {
                requestId,
                reply: replySnapshot,
                error: `The reply was generated but could not be saved: ${error instanceof Error ? error.message : String(error)}`
              })
              return false
            }
          }
          publish('chat:phase', {
            requestId,
            phase: 'routing',
            source: 'intake',
            reason: 'Resolving task and project'
          })
          try {
            assertChatWithinPlan(settings, getSecret)
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Plan limit reached'
            publish('chat:error', { requestId, error: message })
            return false
          }
          appState.chatAbort = controller
          appState.chatStreamActive = true
          appState.activeChatRequestId = payload.requestId
          // Ghost completes share the llama runtime — never race the agent turn.
          abortAllCompletes()
          const { model, agentId, mode } = payload
          let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
          let canonicalHistory: NonNullable<typeof payload.prompt>['history'] | undefined
          // Canonical recent history is independent of renderer pagination. Appending
          // the same request ID is idempotent when optimistic persistence races us.
          if (contextThreadId && payload.prompt) {
            try {
              const recent = await appendChatMessage(
                workspacePath,
                contextThreadId,
                {
                  id: `${requestId}:user`,
                  role: 'user',
                  content: payload.prompt.displayContent ?? payload.prompt.text,
                  createdAt: Date.now()
                },
                payload.model
              )
              canonicalHistory = recent.messages
                .filter((m) => m.id !== `${requestId}:user` && m.role !== 'system')
                .map(({ id, role, content, agentId, agentName }) => ({
                  id,
                  role,
                  content,
                  agentId,
                  agentName
                }))
              // Routing reads a short tail; the prompt takes what its allocation allows.
              payload.prompt.history = canonicalHistory.slice(-ROUTING_HISTORY_MESSAGES)
            } catch (error) {
              publish('chat:error', {
                requestId,
                error: `Could not save conversation: ${error instanceof Error ? error.message : String(error)}`
              })
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
              return false
            }
          }
          // Resolve the route before generating role instructions. A renderer route can
          // be corrected below, so its original agent must never own the final prompt.
          messages = payload.prompt
            ? [
                ...payload.prompt.history.map(({ role, content }) => ({ role, content })),
                { role: 'user', content: payload.prompt.text }
              ]
            : (payload.messages ?? [])
          let promptBuildMs = 0
          const previousAgentId =
            [...(payload.prompt?.history ?? [])]
              .reverse()
              .find((message) => message.role === 'assistant')?.agentId ?? null
          let planningDurationMs = payload.planningDurationMs
          let turnPlan: TurnPlan
          const turnInput: ChatTurnInput = {
            requestId,
            workspacePath,
            settings,
            text: userText,
            model,
            mode,
            manualAgentId: agentId ?? null,
            fileNames: payload.prompt?.attachments.map((file) => file.name),
            previousAgentId,
            forceRoute: payload.forceRoute,
            preserveModelSelection: payload.preserveModelSelection,
            history: payload.prompt?.history,
            threadId: payload.threadId ?? payload.prompt?.threadId,
            skillIds: payload.prompt?.skillIds,
            getSecret,
            signal: controller.signal
          }
          try {
            {
              const planningStartedAt = Date.now()
              turnPlan = await planInitialChatTurn(turnInput)
              planningDurationMs ??= Date.now() - planningStartedAt
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Could not plan the chat turn'
            publish('chat:error', { requestId, error: message })
            if (appState.activeChatRequestId === requestId) {
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
            }
            return false
          }
          if (turnPlan.error) {
            publish('chat:error', { requestId, error: turnPlan.error })
            if (appState.activeChatRequestId === requestId) {
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
            }
            return false
          }
          try {
            const contract = await resolveChatTurnContract(turnInput, turnPlan)
            turnPlan = contract.plan
            if (contract.task.threadId) {
              try {
                contract.task.contextOrigin = await createContextOrigin(
                  {
                    sourceRoot: contract.task.scope.workspaceRoot,
                    threadId: contract.task.threadId,
                    projectRoot: contract.task.scope.projectRoot,
                    taskId: contract.task.taskId
                  },
                  AbortSignal.any([controller.signal, AbortSignal.timeout(150)])
                )
              } catch {
                controller.signal.throwIfAborted() /* Optional source mapping fails closed. */
              }
            }
            saveTask(contract.task)
            workingState = new ThreadWorkingStateBuilder(contract.task, `${requestId}:assistant`)
            publish('chat:task', { requestId, task: contract.task })
          } catch (error) {
            publish('chat:error', {
              requestId,
              error: error instanceof Error ? error.message : 'Task intake failed'
            })
            if (appState.activeChatRequestId === requestId) {
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
            }
            return false
          }
          publish('chat:phase', {
            requestId,
            phase: 'history',
            source: 'intake',
            reason: 'Selecting recent history and recall'
          })
          // One split per turn, so what recall treats as covered is what the prompt sends.
          let allocation: ContextAllocation
          try {
            const selectedModel =
              (turnPlan.mode === 'agent' ? turnPlan.models.tools : turnPlan.models.chat) ||
              model ||
              settings.models.defaultModel
            const budget =
              turnPlan.cloudPreferred ||
              (workspacePath && turnPlan.task?.scope.state !== 'resolved') ||
              taskIntakeBlocked(turnPlan.task, turnPlan.mode)
                ? contextBudgetTokens(settings, selectedModel)
                : await prepareContextBudget(settings, selectedModel, controller.signal)
            allocation = allocateContext(budget, turnPlan.mode === 'agent' ? 'agent' : 'chat')
          } catch (error) {
            if (controller.signal.aborted) publish('chat:done', { requestId, aborted: true })
            else
              publish('chat:error', {
                requestId,
                error: error instanceof Error ? error.message : String(error)
              })
            return false
          }
          publish('chat:phase', {
            requestId,
            phase: 'history',
            source: 'intake',
            reason: 'Selecting recent history and recall'
          })
          if (contextThreadId && payload.prompt) {
            try {
              await scopeChatSource(
                workspacePath,
                contextThreadId,
                `${requestId}:user`,
                turnPlan.task?.scope.projectRoot ?? null
              )
              const recalled = await conversationContext(
                workspacePath,
                contextThreadId,
                userText,
                settings,
                {
                  excludeId: `${requestId}:user`,
                  queryHints: {
                    files: [
                      ...(payload.prompt.openFile ? [payload.prompt.openFile.path] : []),
                      ...payload.prompt.attachments.slice(0, 3).map((file) => file.path),
                      ...(turnPlan.task?.continuation?.changedFiles ?? [])
                    ],
                    task: (turnPlan.task?.recommendations ?? [])
                      .slice(0, 2)
                      .map((item) => item.text)
                      .join(' ')
                  },
                  coveredSourceIds: compactHistory(
                    canonicalHistory ?? payload.prompt.history,
                    historyChars(allocation)
                  ).coveredSourceIds,
                  tokens: allocation.recallTokens,
                  projectRoot: turnPlan.task?.scope.projectRoot ?? null,
                  signal: controller.signal
                }
              )
              conversationMemory = recalled.prompt
              releaseMemoryEvidence = leaseMemoryEvidence({
                root: workspacePath,
                threadId: contextThreadId,
                taskId: requestId,
                prompt: recalled.prompt
              })
              appendTaskEvent(requestId, 'memory-selected', recalled.prompt.manifest)
            } catch (error) {
              if (controller.signal.aborted) throw error
              logWarn('Conversation recall unavailable; using canonical recent history', {
                requestId,
                error: String(error)
              })
            }
          }
          publish('chat:phase', {
            requestId,
            phase: 'prompt',
            source: 'intake',
            reason: 'Building the outbound prompt'
          })
          const promptBuildStartedAt = Date.now()
          try {
            if (payload.prompt) {
              messages = buildChatTurnMessages(
                workspacePath,
                settings,
                canonicalHistory
                  ? { ...payload.prompt, history: canonicalHistory }
                  : payload.prompt,
                turnPlan,
                payload.threadId,
                allocation
              )
            }
            promptBuildMs = Date.now() - promptBuildStartedAt
          } catch (err) {
            const error = err instanceof Error ? err.message : 'Could not build the chat prompt'
            publish('chat:error', { requestId, error })
            if (appState.activeChatRequestId === requestId) {
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
            }
            return false
          }
          const agent =
            findAgent(workspacePath, turnPlan.agentId) ||
            (agentId ? findAgent(workspacePath, agentId) : null)
          let resolvedModel = turnPlan.models.chat || model || settings.models.defaultModel
          const temperature = agent?.temperature ?? settings.models.temperature
          setDiagnosticsPaused(true)
          // Coalesce high-frequency thinking/answer IPC (~40ms) to cut renderer thrash.
          let pendingThinking = ''
          let pendingAnswer = ''
          let coalesceTimer: ReturnType<typeof setTimeout> | null = null
          const flushStreamChunks = () => {
            if (coalesceTimer) {
              clearTimeout(coalesceTimer)
              coalesceTimer = null
            }
            if (pendingThinking) {
              publish('chat:thinking', { requestId, chunk: pendingThinking })
              pendingThinking = ''
            }
            if (pendingAnswer) {
              publish('chat:answer', { requestId, chunk: pendingAnswer })
              pendingAnswer = ''
            }
          }
          const scheduleStreamFlush = () => {
            if (coalesceTimer) return
            coalesceTimer = setTimeout(flushStreamChunks, 40)
          }
          let run: AgentRunRecord | null = null
          let runIncomplete = false
          let finalAnswer = ''
          const outcomeEvidence = new OutcomeEvidence()
          /** Accumulated for project memory even when no checkpoint/run record exists. */
          const evidencePaths = new Set<string>()
          let observedCheck = false
          let memoryFiles: string[] = []
          let memoryActions: string[] = []
          // #10 opt-in agent telemetry
          const telemetryOn = settings.general.telemetry?.agentOutcomes === true
          let telemetrySteps = 0
          let telemetryMutated = false
          let verifiedAfterLastEdit = false
          let verificationState: 'passed' | 'failed' | 'not-run' = 'not-run'
          let editOwner: string | undefined
          let mixedEditOwners = false
          let usedCloud = false
          let firstModelOutputMs: number | null = null
          const noteFirstAgentOutput = (evt: { type: string; text?: string }) => {
            const hasOutput =
              (evt.type === 'thinking' || evt.type === 'answer') && Boolean(evt.text)
            if (firstModelOutputMs !== null || (!hasOutput && evt.type !== 'tool')) {
              return
            }
            firstModelOutputMs = externalPlanningDurationMs + Date.now() - requestReceivedAt
            logInfo('Chat first agent output', {
              requestId,
              firstOutputMs: firstModelOutputMs,
              outputType: evt.type
            })
          }
          const recordTelemetry = (outcome: 'done' | 'incomplete' | 'aborted') => {
            if (!telemetryOn) return
            try {
              recordAgentRun({
                model: usedCloud ? 'composer' : resolvedModel,
                settings,
                intent: turnPlan.intent,
                steps: telemetrySteps,
                mutated: telemetryMutated,
                incomplete: outcome === 'incomplete',
                aborted: outcome === 'aborted',
                verifiedEditMs:
                  verifiedAfterLastEdit &&
                  !usedCloud &&
                  !mixedEditOwners &&
                  editOwner === resolvedModel
                    ? Date.now() - requestReceivedAt
                    : undefined
              })
            } catch {
              /* telemetry is best-effort */
            }
          }
          const persistRun = (patch: Partial<AgentRunRecord>) => {
            if (!run || !workspacePath) return
            run = { ...run, ...patch }
            saveAgentRun(workspacePath, run)
            if (run.sessionId && patch.status) {
              setAgentSessionStatus(workspacePath, run.sessionId, patch.status)
            }
          }
          try {
            logInfo('Chat stream start', {
              requestId,
              model: resolvedModel,
              toolsModel: turnPlan.models.tools,
              agentId: turnPlan.agentId,
              intent: turnPlan.intent,
              mode: mode ?? 'agent',
              messages: messages.length,
              planningMs: planningDurationMs ?? null,
              promptBuildMs,
              promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
              setupMs: Date.now() - requestReceivedAt
            })
            const route = turnPlanToRouteResult(turnPlan)
            publish('chat:routed', {
              requestId,
              agentId: route.agentId,
              agentName: route.agentName,
              model: resolvedModel,
              reason: turnPlan.reason,
              intent: turnPlan.intent,
              toolPolicy: turnPlan.toolPolicy,
              executionPlan: turnPlan.executionPlan,
              task: turnPlan.task,
              toolsModel: turnPlan.models.tools,
              modelSelection:
                turnPlan.modelExecution?.policy === 'fixed'
                  ? turnPlan.modelExecution.selection
                  : turnPlan.modelExecution?.policy
            })
            pendingThinking += `Route: ${turnPlan.reason}${turnPlan.classifiedIntent && turnPlan.classifiedIntent !== turnPlan.intent ? ` (classified ${turnPlan.classifiedIntent})` : ''} · tools ${turnPlan.toolPolicy}\n`
            if (turnPlan.executionPlan) {
              pendingThinking += `Plan: ${turnPlan.executionPlan.steps.join(' → ')}. Done when: ${turnPlan.executionPlan.doneWhen}\n`
            }
            scheduleStreamFlush()

            const threadId = payload.threadId ?? null
            if (workspacePath) {
              configureBackgroundAgents({ sender: chatSender(), getSecret })
            }
            const chatChildIds: string[] = []
            const publishDelegations = () => {
              const terminal = new Set(['done', 'failed', 'stopped', 'merged', 'discarded'])
              for (const id of chatChildIds) {
                const job = getBackgroundJob(id)
                if (!job) continue
                const named = findAgent(workspacePath, job.agentId)
                const failed =
                  job.status === 'failed' || job.status === 'stopped' || job.status === 'discarded'
                publish('chat:delegation', {
                  requestId,
                  delegation: {
                    id: job.id,
                    agentId: job.agentId,
                    agentName: job.agentName || named?.name || job.agentId,
                    goal: job.goal,
                    status: failed ? 'failed' : terminal.has(job.status) ? 'done' : 'running',
                    tools: (job.recentTools || []).slice(-6).map((tool) => ({
                      name: tool.name,
                      path: tool.path,
                      status: tool.status
                    })),
                    result: (job.answer || job.liveStatus || '').slice(0, AGENT_HANDOFF_CHARS)
                  }
                })
              }
            }

            // Agent mode: prefer Cloud Composer inline in chat (thinking/tools/answer),
            // not a background Agents-panel job. Fall back to local Lite on failure.
            // Only hand off to Cloud Composer when the turn would otherwise run the
            // built-in local model. If the user picked their own API/cloud model
            // (OpenAI, Anthropic, OpenRouter, Ollama, …), run it directly in the
            // local agent loop so BYO keys are first-class in Agent mode.
            const usingComposerFull =
              turnPlan.models.tools === 'builtin:composer' ||
              turnPlan.models.chat === 'builtin:composer'
            const cloudPreferred = turnPlan.cloudPreferred === true && usingComposerFull
            const wantCloudInline =
              !asksForImageGeneration(userText) &&
              (mode ?? 'agent') === 'agent' &&
              turnPlan.mode === 'agent' &&
              Boolean(workspacePath) &&
              usingComposerFull &&
              cloudPreferred

            const cloudCompatible =
              wantCloudInline &&
              (await cloudInlineAvailable(settings, getSecret, turnPlan.task?.version))
            if (wantCloudInline && !cloudCompatible) {
              if (!turnPlan.modelExecution || turnPlan.modelExecution.policy === 'fixed')
                throw new Error(
                  'Fixed Cloud Composer is unavailable. Select another model or an automatic execution policy to continue.'
                )
              const fallback = await chooseExecutionModel(settings, turnPlan.intent, 'auto-local', [
                resolvedModel
              ])
              if (!fallback.model)
                throw new Error(
                  `Cloud Composer is unavailable and no eligible local worker is ready. ${fallback.candidates.map((c) => `${c.model}: ${c.reason}`).join('; ')}`
                )
              const coordinator = resolvedModel
              resolvedModel = fallback.model
              turnPlan = {
                ...turnPlan,
                cloudPreferred: false,
                models: {
                  ...turnPlan.models,
                  coordinator,
                  chat: resolvedModel,
                  tools: resolvedModel
                },
                modelExecution: {
                  ...turnPlan.modelExecution,
                  candidates: fallback.candidates,
                  basis: 'cloud-unavailable'
                }
              }
              publish('chat:status', {
                requestId,
                text: `Cloud server is unavailable or lacks the required task contract. Continuing with ${resolvedModel} under the same permissions.`
              })
            }
            if (cloudCompatible) {
              let cloudWorkObserved = false
              try {
                assertCloudJobWithinPlan(settings, getSecret)
                usedCloud = true
                publish('chat:model', {
                  requestId,
                  model: 'composer',
                  agentId: turnPlan.agentId,
                  agentName: turnPlan.agentName
                })
                for await (const evt of runCloudAgentInline({
                  task: turnPlan.task,
                  workspacePath: workspacePath!,
                  settings,
                  goal: userText,
                  agentId: turnPlan.agentId,
                  agentName: turnPlan.agentName,
                  getSecret,
                  signal: controller.signal
                })) {
                  if (evt.type === 'tool') cloudWorkObserved = true
                  workingState?.observe(evt)
                  noteFirstAgentOutput(evt)
                  if (evt.type === 'diff' && evidencePaths.size < 32)
                    evidencePaths.add(evt.diff.path)
                  if (evt.type === 'tool' && evt.tool.name === 'verify') observedCheck = true
                  if (evt.type === 'thinking') {
                    pendingThinking += evt.text
                    scheduleStreamFlush()
                  } else if (evt.type === 'answer') {
                    pendingAnswer += evt.text
                    scheduleStreamFlush()
                  } else {
                    flushStreamChunks()
                    if (evt.type === 'tool') {
                      publish('chat:tool', { requestId, tool: evt.tool })
                    } else if (evt.type === 'diff') {
                      telemetryMutated = true
                      publish('chat:diff', { requestId, diff: evt.diff })
                    } else if (evt.type === 'checkpoint') {
                      publish('chat:checkpoint', {
                        requestId,
                        checkpointId: evt.checkpointId
                      })
                    } else if (evt.type === 'workspace-changed') {
                      publish('chat:workspace-changed', { requestId })
                    } else if (evt.type === 'status') {
                      publish('chat:status', { requestId, text: evt.text })
                    } else if (evt.type === 'model') {
                      resolvedModel = evt.model
                      publish('chat:model', {
                        requestId,
                        model: evt.model,
                        agentId: evt.agentId ?? turnPlan.agentId,
                        agentName: evt.agentName ?? turnPlan.agentName
                      })
                    }
                  }
                }
                flushStreamChunks()
                persistRun({ status: 'done' })
                recordTelemetry('done')
                try {
                  const mem = rememberAgentRun(workspacePath, getResolvedSettings(workspacePath), {
                    goal: userText,
                    filesTouched: memoryFiles,
                    actionLog: memoryActions,
                    aborted: false
                  })
                  if (mem.needsConfirm) {
                    publish('chat:memory-proposal', {
                      requestId,
                      note: mem.note,
                      summary: mem.summary,
                      preview: mem.preview
                    })
                  } else if (mem.wrote) {
                    publish('chat:memory-updated', {
                      requestId,
                      kind: mem.kind,
                      preview: mem.preview
                    })
                  }
                } catch {
                  /* memory is best-effort */
                }
                if (!(await persistReply('done'))) return false
                publish('chat:done', { requestId, reply: replySnapshot })
                logInfo('Chat stream done (cloud inline)', {
                  requestId,
                  totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
                  firstOutputMs: firstModelOutputMs,
                  promptBuildMs
                })
                return true
              } catch (cloudErr) {
                if ((cloudErr as Error).name === 'AbortError') {
                  flushStreamChunks()
                  persistRun({ status: 'stopped' })
                  if (!(await persistReply('stopped'))) return false
                  publish('chat:done', { requestId, aborted: true, reply: replySnapshot })
                  return false
                }
                if (!turnPlan.modelExecution || turnPlan.modelExecution.policy === 'fixed')
                  throw cloudErr
                if (telemetryMutated || cloudWorkObserved)
                  throw new Error(
                    'Cloud execution stopped after beginning workspace work. Existing changes are preserved; automatic model recovery was stopped to avoid replaying operations.'
                  )
                const fallback = await chooseExecutionModel(
                  settings,
                  turnPlan.intent,
                  'auto-local',
                  [resolvedModel]
                )
                if (!fallback.model)
                  throw new Error(
                    `Cloud execution failed and no eligible local recovery model is available. ${fallback.candidates.map((c) => `${c.model}: ${c.reason}`).join('; ')}`
                  )
                logWarn('Cloud inline chat falling back to local', {
                  requestId,
                  error: cloudErr instanceof Error ? cloudErr.message : String(cloudErr)
                })
                pendingThinking += `\nCloud unavailable — continuing with ${fallback.model}.\n`
                usedCloud = false
                const coordinator = resolvedModel
                resolvedModel = fallback.model
                turnPlan = {
                  ...turnPlan,
                  models: {
                    ...turnPlan.models,
                    coordinator,
                    chat: resolvedModel,
                    tools: resolvedModel
                  },
                  modelExecution: {
                    ...turnPlan.modelExecution,
                    candidates: fallback.candidates,
                    basis: 'cloud-recovery'
                  },
                  cloudPreferred: false
                }
                scheduleStreamFlush()
              }
            }

            const localTurn = localChatTurnModel(turnPlan, resolvedModel, settings)
            resolvedModel = localTurn.model
            turnPlan = localTurn.plan

            for await (const evt of runAgentWithWorkspaceTools({
              workspacePath: workspacePath,
              settings,
              model: resolvedModel,
              messages,
              conversationMemory,
              conversationSource: contextThreadId
                ? {
                    root: workspacePath,
                    threadId: contextThreadId,
                    excludeId: `${requestId}:user`
                  }
                : undefined,
              temperature,
              signal: controller.signal,
              getSecret,
              mode: mode ?? 'agent',
              turnPlan,
              jobId: `chat:${requestId}`,
              onDelegate: async (req) => {
                if (!workspacePath) {
                  return { ok: false, detail: 'Open a workspace to delegate' }
                }
                try {
                  const child = delegateFromAgent({
                    workspacePath: workspacePath,
                    parentJobId: null,
                    sourceThreadId: threadId,
                    model: resolvedModel,
                    agentId: req.agentId,
                    goal: req.goal,
                    summary: req.summary,
                    files: req.files,
                    openQuestions: req.openQuestions,
                    confidence: req.confidence,
                    claim: req.claim,
                    handoff: req.handoff
                  })
                  // Track children under a soft parent list on a marker job? Use childIds via patch —
                  // without a parent job, await_children needs another approach: collect ids locally.
                  chatChildIds.push(child.id)
                  publishDelegations()
                  publish('chat:status', {
                    requestId,
                    text: `Delegated → ${req.agentId}`
                  })
                  return {
                    ok: true,
                    childJobId: child.id,
                    detail: `Spawned ${req.agentId} in Agents inbox · ${child.id}`
                  }
                } catch (err) {
                  return {
                    ok: false,
                    detail: err instanceof Error ? err.message : String(err)
                  }
                }
              },
              onAwaitChildren: async (timeoutMs) => {
                if (chatChildIds.length === 0) {
                  return { ok: true, detail: 'No delegated children' }
                }
                const deadline = Date.now() + Math.max(5_000, Math.min(timeoutMs, 30 * 60_000))
                const terminal = new Set(['done', 'failed', 'stopped', 'merged', 'discarded'])
                publish('chat:phase', {
                  requestId,
                  phase: 'waiting-child',
                  source: 'coordinator',
                  reason: 'Waiting for delegated agents'
                })
                while (Date.now() < deadline) {
                  if (controller.signal.aborted) {
                    publishDelegations()
                    return { ok: false, detail: 'Aborted while waiting for children' }
                  }
                  publishDelegations()
                  const children = chatChildIds.map((id) => getBackgroundJob(id)).filter(Boolean)
                  const pending = children.filter((c) => c && !terminal.has(c.status))
                  if (pending.length === 0) {
                    publish('chat:phase', {
                      requestId,
                      phase: 'integrating',
                      source: 'coordinator',
                      reason: 'Delegated agents completed'
                    })
                    return summarizeAgentResults(
                      chatChildIds.map((id) => getBackgroundJob(id) ?? undefined)
                    )
                  }
                  await new Promise((r) => setTimeout(r, 500))
                }
                return { ok: false, detail: 'Timed out waiting for delegated children' }
              },
              approveCommand: async (kind, command) => {
                const live = getResolvedSettings(workspacePath)
                const workspaceAllowed = workspaceAllowedCommands(workspacePath)
                if (!commandNeedsApproval(live, kind, command, workspaceAllowed, workspacePath))
                  return true
                flushStreamChunks()
                publish('chat:phase', {
                  requestId,
                  phase: 'approval',
                  source: 'coordinator',
                  reason: 'Command or tool approval required'
                })
                const decision = await requestCommandApproval(
                  chatSender(),
                  requestId,
                  kind,
                  command,
                  controller.signal
                )
                publish('chat:phase', {
                  requestId,
                  phase: 'integrating',
                  source: 'coordinator',
                  reason: 'Approval response received'
                })
                logInfo('Command approval', { requestId, kind, command, decision })
                if (decision === 'always') {
                  if (workspacePath) {
                    addWorkspaceAllowedCommand(workspacePath, normalizeCommand(command))
                  } else {
                    const allowed = [
                      ...new Set([...live.agent.allowedCommands, normalizeCommand(command)])
                    ]
                    setSettings('user', { agent: { allowedCommands: allowed } }, null)
                  }
                }
                return decision !== 'deny'
              },
              approveMcpTool: async (toolName, args) => {
                flushStreamChunks()
                const preview = formatMcpApprovalPreview(args)
                publish('chat:phase', {
                  requestId,
                  phase: 'approval',
                  source: 'coordinator',
                  reason: 'Command or tool approval required'
                })
                const decision = await requestCommandApproval(
                  chatSender(),
                  requestId,
                  'mcp',
                  preview,
                  controller.signal,
                  { toolName, canAlwaysAllow: false }
                )
                publish('chat:phase', {
                  requestId,
                  phase: 'integrating',
                  source: 'coordinator',
                  reason: 'Approval response received'
                })
                logInfo('MCP tool approval', { requestId, toolName, decision })
                return decision !== 'deny'
              },
              askUser: async (question, choices) => {
                flushStreamChunks()
                const outcome = await requestUserQuestion(chatSender(), requestId, question, {
                  choices,
                  timeoutMs: USER_QUESTION_TIMEOUT_MS,
                  signal: controller.signal
                })
                workingState?.question(question, outcome.kind === 'reply')
                logInfo('User question', {
                  requestId,
                  kind: outcome.kind,
                  question: question.slice(0, 120)
                })
                if (outcome.kind === 'reply') {
                  const mem = rememberAskUserReply(
                    workspacePath,
                    getResolvedSettings(workspacePath),
                    question,
                    outcome.text
                  )
                  if (mem.needsConfirm) {
                    publish('chat:memory-proposal', {
                      requestId,
                      note: mem.note,
                      summary: mem.summary,
                      preview: mem.preview
                    })
                  } else if (mem.wrote) {
                    publish('chat:memory-updated', {
                      requestId,
                      kind: mem.kind,
                      preview: mem.preview
                    })
                  }
                  return outcome.text
                }
                return null
              }
            })) {
              workingState?.observe(evt)
              noteFirstAgentOutput(evt)
              if (evt.type === 'evidence' && evt.evidence.path && evidencePaths.size < 32)
                evidencePaths.add(evt.evidence.path)
              if (evt.type === 'diff' && evidencePaths.size < 32) evidencePaths.add(evt.diff.path)
              if (evt.type === 'diff' || (evt.type === 'evidence' && evt.evidence.mutated)) {
                verifiedAfterLastEdit = false
                verificationState = 'not-run'
                editOwner ??= resolvedModel
                if (editOwner !== resolvedModel) mixedEditOwners = true
              }
              if (evt.type === 'tool' && evt.tool.name === 'verify') {
                observedCheck = true
                if (evt.tool.status !== 'running') {
                  verifiedAfterLastEdit = evt.tool.status === 'ok'
                  verificationState = verifiedAfterLastEdit ? 'passed' : 'failed'
                }
              }
              if (evt.type === 'thinking') {
                pendingThinking += evt.text
                scheduleStreamFlush()
              } else if (evt.type === 'answer') {
                finalAnswer = evt.replace ? evt.text : finalAnswer + evt.text
                if (evt.replace) {
                  pendingAnswer = ''
                  flushStreamChunks()
                  publish('chat:answer', { requestId, chunk: evt.text, replace: true })
                } else {
                  pendingAnswer += evt.text
                  scheduleStreamFlush()
                }
              } else {
                flushStreamChunks()
                if (evt.type === 'asset') {
                  publish('chat:asset', { requestId, asset: evt.asset })
                } else if (evt.type === 'evidence') {
                  publish('chat:evidence', { requestId, evidence: evt.evidence })
                } else if (evt.type === 'tool') {
                  outcomeEvidence.observe(evt)
                  publish('chat:tool', { requestId, tool: evt.tool })
                } else if (evt.type === 'diff') {
                  outcomeEvidence.observe(evt)
                  telemetryMutated = true
                  publish('chat:diff', { requestId, diff: evt.diff })
                } else if (evt.type === 'checkpoint') {
                  publish('chat:checkpoint', {
                    requestId,
                    checkpointId: evt.checkpointId
                  })
                  if (workspacePath) {
                    const now = new Date().toISOString()
                    const session = createAgentSession(workspacePath, {
                      requestId,
                      threadId,
                      goal: userText,
                      agentId: turnPlan.agentId,
                      mode: mode ?? 'agent',
                      checkpointId: evt.checkpointId
                    })
                    const sessionId = session.id
                    run = {
                      id: requestId,
                      requestId,
                      goal: userText,
                      agentId: turnPlan.agentId,
                      mode: mode ?? 'agent',
                      checkpointId: evt.checkpointId,
                      sessionId,
                      status: 'running',
                      step: 0,
                      actionLog: [],
                      filesTouched: [],
                      startedAt: now,
                      updatedAt: now
                    }
                    persistRun({})
                    publish('chat:session', {
                      requestId,
                      sessionId,
                      checkpointId: evt.checkpointId
                    })
                  }
                } else if (evt.type === 'session-step') {
                  memoryFiles = [...new Set(evt.filesTouched)].slice(-200)
                  memoryActions = evt.actionLog.slice(-120)
                  telemetrySteps = evt.step
                  if (evt.filesTouched.length) telemetryMutated = true
                  if (run?.sessionId && workspacePath) {
                    appendSessionStep(workspacePath, run.sessionId, {
                      step: evt.step,
                      opThrough: evt.opThrough,
                      summary: evt.summary,
                      actionLog: evt.actionLog,
                      filesTouched: evt.filesTouched,
                      workerMessages: evt.workerMessages
                    })
                    publish('chat:session-step', {
                      requestId,
                      sessionId: run.sessionId,
                      step: evt.step,
                      summary: evt.summary,
                      opThrough: evt.opThrough,
                      filesTouched: evt.filesTouched
                    })
                  }
                  persistRun({
                    step: evt.step,
                    actionLog: memoryActions,
                    filesTouched: memoryFiles
                  })
                } else if (evt.type === 'progress') {
                  if (evt.incomplete) runIncomplete = true
                  telemetrySteps = evt.step
                  if (evt.filesTouched.length) telemetryMutated = true
                  memoryFiles = [...new Set(evt.filesTouched)].slice(-200)
                  memoryActions = evt.actionLog.slice(-120)
                  persistRun({
                    step: evt.step,
                    actionLog: memoryActions,
                    filesTouched: memoryFiles
                  })
                } else if (evt.type === 'terminal') {
                  publish('chat:terminal', { requestId, text: evt.text })
                } else if (evt.type === 'workspace-changed') {
                  publish('chat:workspace-changed', { requestId })
                } else if (evt.type === 'status') {
                  publish('chat:status', { requestId, text: evt.text })
                } else if (evt.type === 'delegation') {
                  publish('chat:delegation', { requestId, delegation: evt.delegation })
                } else if (evt.type === 'adapt') {
                  if (evt.agentId || evt.agentName || evt.model) {
                    turnPlan = {
                      ...turnPlan,
                      agentId: evt.agentId ?? turnPlan.agentId,
                      agentName: evt.agentName ?? turnPlan.agentName,
                      models: evt.model ? { ...turnPlan.models, tools: evt.model } : turnPlan.models
                    }
                  }
                  publish('chat:status', {
                    requestId,
                    text: evt.reason
                  })
                  if (evt.model) {
                    resolvedModel = evt.model
                    publish('chat:model', {
                      requestId,
                      model: evt.model,
                      agentId: evt.agentId ?? agent?.id ?? agentId,
                      agentName: evt.agentName ?? agent?.name
                    })
                  }
                } else if (evt.type === 'model') {
                  resolvedModel = evt.model
                  publish('chat:model', {
                    requestId,
                    model: evt.model,
                    agentId: evt.agentId ?? agent?.id ?? agentId,
                    agentName: evt.agentName ?? agent?.name
                  })
                }
              }
            }
            completionEvidence = {
              execution: runIncomplete ? 'incomplete' : 'completed',
              verification: verificationState,
              assessment: { status: 'not-run' },
              persistence: contextThreadId ? 'saved' : 'not-required'
            }
            if (turnPlan.task && needsOutcomeReview(turnPlan, runIncomplete)) {
              publish('chat:status', {
                requestId,
                text: 'Checking the response against task evidence…'
              })
              outcomeEvidence.addActions(memoryActions)
              const verdict = await reviewTaskOutcome({
                task: turnPlan.task,
                answer: finalAnswer,
                evidence: outcomeEvidence.items,
                settings,
                model: turnPlan.models.chat,
                signal: controller.signal,
                getSecret
              })
              publish('chat:outcome', { requestId, ...verdict })
              // Recorded in every case, so the stored reply keeps what the reviewer said.
              completionEvidence.assessment = {
                status: verdict.verdict, failure: verdict.failure, reason: verdict.reason
              }
              const reviewerUnavailable =
                verdict.verdict === 'unresolved' && REVIEWER_UNAVAILABLE.has(verdict.failure ?? '')
              if (reviewerUnavailable) {
                // The reviewer did not run to a verdict (most often its 15 s deadline on a
                // local model). That is not evidence against the answer: the run keeps the
                // status its own execution and verification earned (#500).
                appendTaskEvent(requestId, 'outcome-review-unavailable', { failure: verdict.failure })
              } else if (verdict.verdict !== 'supported') {
                // A real disagreement marks the run incomplete. The verdict is shown under
                // the reply from contextResult.completion.assessment, not appended to the
                // answer text: text in the body is sent back to the model as its own words
                // on the next turn and was being repeated as a finding (#502).
                runIncomplete = true
              }
            }
            if (turnPlan.task) {
              // The next turn in this thread resolves “those” and “what changed?” against this.
              try {
                saveTask(
                  completeChatTurnTask(turnPlan.task, {
                    answer: finalAnswer,
                    changedFiles: memoryFiles.length ? memoryFiles : (run?.filesTouched ?? []),
                    terminal: runIncomplete ? 'incomplete' : 'complete'
                  })
                )
              } catch (error) {
                completionEvidence.persistence = 'failed'
                runIncomplete = true
                logWarn('Task result was not saved', {
                  requestId,
                  error: error instanceof Error ? error.message : String(error)
                })
                const changed = memoryFiles.length ? memoryFiles : (run?.filesTouched ?? [])
                flushStreamChunks()
                publish('chat:status', { requestId, text: 'Incomplete · task result could not be saved' })
                publish('chat:answer', {
                  requestId, replace: true,
                  chunk: `${visibleAnswer}\n\nTask result could not be saved. Applied changes are preserved${changed.length ? `: ${changed.join(', ')}` : '.'} Follow-up recovery is unavailable until storage is repaired; inspect the files before retrying.`
                })
              }
            }
            await flushTaskLedger(requestId)
            flushStreamChunks()
            persistRun({ status: runIncomplete ? 'incomplete' : 'done' })
            recordTelemetry(runIncomplete ? 'incomplete' : 'done')
            try {
              const mem = rememberAgentRun(workspacePath, getResolvedSettings(workspacePath), {
                goal: userText,
                filesTouched: memoryFiles.length ? memoryFiles : (run?.filesTouched ?? []),
                actionLog: memoryActions.length ? memoryActions : (run?.actionLog ?? []),
                incomplete: runIncomplete,
                aborted: false
              })
              if (mem.needsConfirm) {
                publish('chat:memory-proposal', {
                  requestId,
                  note: mem.note,
                  summary: mem.summary,
                  preview: mem.preview
                })
              } else if (mem.wrote) {
                publish('chat:memory-updated', {
                  requestId,
                  kind: mem.kind,
                  preview: mem.preview
                })
              }
            } catch (memErr) {
              logWarn('Project memory write skipped', {
                requestId,
                error: memErr instanceof Error ? memErr.message : String(memErr)
              })
            }
            if (!(await persistReply(runIncomplete ? 'incomplete' : 'done'))) return false
            publish('chat:done', { requestId, incomplete: runIncomplete, reply: replySnapshot })
            logInfo('Chat stream done', {
              requestId,
              model: resolvedModel,
              totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
              firstOutputMs: firstModelOutputMs,
              promptBuildMs
            })
            return true
          } catch (err) {
            flushStreamChunks()
            if ((err as Error).name === 'AbortError') {
              if (memoryFiles.length) publish('chat:answer', {
                requestId, replace: true,
                chunk: `${visibleAnswer}${visibleAnswer ? '\n\n' : ''}Stopped. Applied changes: ${memoryFiles.join(', ')}. Remaining work and verification may be incomplete; inspect the files before retrying.`
              })
              persistRun({ status: 'stopped' })
              recordTelemetry('aborted')
              logWarn('Chat stream aborted', {
                requestId,
                totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
                firstOutputMs: firstModelOutputMs,
                promptBuildMs
              })
              if (!(await persistReply('stopped'))) return false
              publish('chat:done', { requestId, aborted: true, reply: replySnapshot })
              return false
            }
            const message = err instanceof Error ? err.message : 'Chat failed'
            completionEvidence = {execution:'incomplete',verification:verificationState,
              assessment:{status:'not-run'},persistence:contextThreadId ? 'saved' : 'not-required'}
            publish('chat:answer', {requestId,replace:true,
              chunk:`${visibleAnswer}${visibleAnswer ? '\n\n' : ''}Partial response: the request failed before completion.${memoryFiles.length ? ` Applied changes: ${memoryFiles.join(', ')}. Verification and remaining work may be incomplete.` : ''}`})
            persistRun({ status: 'failed', error: message })
            logError('Chat stream failed', {
              requestId,
              model: resolvedModel,
              error: message,
              totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
              firstOutputMs: firstModelOutputMs,
              promptBuildMs
            })
            if (!(await persistReply('failed'))) return false
            publish('chat:error', {
              requestId,
              error: message,
              reply: replySnapshot
            })
            // Don't rethrow — returning keeps the renderer invoke from rejecting as an unhandled crash
            return false
          } finally {
            if (coalesceTimer) clearTimeout(coalesceTimer)
            if (appState.activeChatRequestId === requestId) setDiagnosticsPaused(false)
            if (appState.activeChatRequestId === requestId) {
              appState.chatStreamActive = false
              appState.activeChatRequestId = null
            }
          }
        } finally {
          releaseMemoryEvidence()
          if (appState.chatAbort === controller) {
            appState.chatStreamActive = false
            appState.activeChatRequestId = null
            appState.chatAbort = null
            setDiagnosticsPaused(false)
          }
        }
      })
      return await foregroundTasks.run(payload.requestId, event.sender, run)
    } catch (error) {
      const stopped = error instanceof Error && error.name === 'AbortError'
      // A task that already ended keeps its outcome; this one is recorded as late only.
      const ended = isChatJobTerminal(payload.requestId)
      finishChatJob(payload.requestId, stopped ? 'stopped' : 'failed')
      if (ended) return false
      event.sender.send(stopped ? 'chat:done' : 'chat:error', {
        requestId: payload.requestId,
        ...(stopped
          ? { aborted: true }
          : { error: error instanceof Error ? error.message : 'Task failed' })
      })
      return false
    }
  })

  ipcMain.handle(
    'chat:approvalRespond',
    (event, approvalId: string, decision: CommandApprovalDecision) => {
      if (appState.mainWindow && event.sender !== appState.mainWindow.webContents) return false
      return resolveCommandApproval(
        approvalId,
        decision === 'allow' || decision === 'always' ? decision : 'deny'
      )
    }
  )

  ipcMain.handle('chat:questionRespond', (event, questionId: string, reply: string | null) => {
    if (appState.mainWindow && event.sender !== appState.mainWindow.webContents) return false
    if (
      typeof questionId !== 'string' ||
      questionId.length > 256 ||
      (reply !== null && (typeof reply !== 'string' || reply.length > 128000))
    )
      return false
    return resolveUserQuestion(questionId, reply)
  })

  ipcMain.handle('sessions:listSteps', (_e, sessionId: string) =>
    listSessionSteps(appState.currentWorkspace, String(sessionId))
  )
  ipcMain.handle('sessions:get', (_e, sessionId: string) =>
    loadAgentSession(appState.currentWorkspace, String(sessionId))
  )
  ipcMain.handle('chat:jobLatest', (event, threadId?: string | null) => {
    if (appState.mainWindow && event.sender !== appState.mainWindow.webContents) return null
    if (threadId != null && !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) return null
    const job = getLatestChatJob(appState.currentWorkspace, threadId)
    if (!job) return null
    return {
      ...job,
      interactions: ['queued', 'running'].includes(job.status)
        ? {
            approvals: pendingCommandApprovals(job.id, event.sender),
            questions: pendingUserQuestions(job.id, event.sender)
          }
        : undefined
    }
  })

  ipcMain.handle('chat:stop', (event, requestId?: string) => {
    if (!requestId || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return false
    if (appState.mainWindow && event.sender !== appState.mainWindow.webContents) return false
    const stopped = foregroundTasks.stop(requestId, event.sender)
    if (stopped) {
      denyAllPendingApprovals(requestId)
      cancelAllPendingQuestions(requestId)
    }
    return stopped
  })
}
