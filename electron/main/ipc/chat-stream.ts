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
import { conversationContext } from '../services/context-memory'
import { leaseMemoryEvidence } from '../services/memory-dispatch'
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
import { finalizePostedAnswer } from '../../../src/shared/posted-answer'
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
  markChatJobRunning
} from '../services/chat-job-controller'

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
      return await foregroundTasks.run(payload.requestId, event.sender, async (controller) => {
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
          const persistReply = async (terminal: string) => {
            if (!contextThreadId) return true
            const { content, thinking } = finalizePostedAnswer(
              visibleAnswer,
              visibleThinking,
              terminal === 'stopped',
              replyAssets.length > 0
            )
            if (!content && !replyAssets.length) return true
            try {
              const selectedPaths = [...new Set([...evidencePaths, ...memoryFiles])]
              let dependencies =
                workspacePath && (selectedPaths.length || observedCheck)
                  ? await captureReceiptEvidence(workspacePath, selectedPaths)
                  : undefined
              if (dependencies && !selectedPaths.length)
                dependencies = { ...dependencies, complete: false }
              await appendChatMessage(workspacePath, contextThreadId, {
                id: `${requestId}:assistant`,
                role: 'assistant',
                content,
                thinking: thinking || undefined,
                assets: replyAssets.length ? [...replyAssets] : undefined,
                delegations: replyDelegations.size ? [...replyDelegations.values()] : undefined,
                createdAt: Date.now(),
                model: replyModel,
                agentId: replyAgentId ?? turnPlan?.agentId,
                agentName: replyAgentName,
                contextResult: {
                  workingState: workingState?.snapshot(terminal),
                  taskId: requestId,
                  terminal,
                  dependencies,
                  projectRoot: turnPlan?.task?.scope.projectRoot ?? null,
                  changedFiles: memoryFiles.slice(0, 200)
                }
              })
              return true
            } catch (error) {
              publish('chat:error', {
                requestId,
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
              payload.prompt.history = recent.messages
                .filter((m) => m.id !== `${requestId}:user` && m.role !== 'system')
                .slice(-20)
                .map(({ id, role, content, agentId, agentName }) => ({
                  id,
                  role,
                  content,
                  agentId,
                  agentName
                }))
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
            previousAgentId,
            forceRoute: payload.forceRoute,
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
                  coveredSourceIds: compactHistory(
                    payload.prompt.history,
                    turnPlan.mode === 'agent' ? 6000 : 24000
                  ).coveredSourceIds,
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
          const promptBuildStartedAt = Date.now()
          try {
            if (payload.prompt) {
              messages = buildChatTurnMessages(
                workspacePath,
                settings,
                payload.prompt,
                turnPlan,
                payload.threadId
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
                model: usedCloud ? 'composer' : turnPlan.models.tools,
                intent: turnPlan.intent,
                steps: telemetrySteps,
                mutated: telemetryMutated,
                incomplete: outcome === 'incomplete',
                aborted: outcome === 'aborted'
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
              toolsModel: turnPlan.models.tools
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
            const cloudPreferred =
              turnPlan.cloudPreferred !== false &&
              usingComposerFull &&
              (settings.agent.routing.profile ?? 'auto') !== 'local' &&
              settings.agent.routing.preferCloudComposer !== false
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
            if (wantCloudInline && !cloudCompatible)
              publish('chat:status', {
                requestId,
                text: 'Cloud server is unavailable or lacks the required task contract. Continuing locally with the same permissions.'
              })
            if (cloudCompatible) {
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
                publish('chat:done', { requestId })
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
                  publish('chat:done', { requestId, aborted: true })
                  return false
                }
                logWarn('Cloud inline chat falling back to local', {
                  requestId,
                  error: cloudErr instanceof Error ? cloudErr.message : String(cloudErr)
                })
                pendingThinking += '\nCloud unavailable — continuing with Composer Lite.\n'
                resolvedModel = 'builtin:composer-lite'
                turnPlan = {
                  ...turnPlan,
                  models: { ...turnPlan.models, chat: resolvedModel, tools: resolvedModel },
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
                  if (appState.chatAbort?.signal.aborted) {
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
                if (!commandNeedsApproval(live, kind, command, workspaceAllowed)) return true
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
                  appState.chatAbort?.signal
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
                  appState.chatAbort?.signal,
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
                  signal: appState.chatAbort?.signal
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
              if (evt.type === 'tool' && evt.tool.name === 'verify') observedCheck = true
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
                    publish('chat:model', {
                      requestId,
                      model: evt.model,
                      agentId: evt.agentId ?? agent?.id ?? agentId,
                      agentName: evt.agentName ?? agent?.name
                    })
                  }
                } else if (evt.type === 'model') {
                  publish('chat:model', {
                    requestId,
                    model: evt.model,
                    agentId: evt.agentId ?? agent?.id ?? agentId,
                    agentName: evt.agentName ?? agent?.name
                  })
                }
              }
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
              if (verdict.verdict !== 'supported') {
                runIncomplete = true
                flushStreamChunks()
                publish('chat:answer', {
                  requestId,
                  chunk: `${finalAnswer}\n\nOutcome check: ${verdict.verdict}. ${verdict.reason}`,
                  replace: true
                })
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
                logWarn('Task result was not saved', {
                  requestId,
                  error: error instanceof Error ? error.message : String(error)
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
            publish('chat:done', { requestId, incomplete: runIncomplete })
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
              persistRun({ status: 'stopped' })
              recordTelemetry('aborted')
              logWarn('Chat stream aborted', {
                requestId,
                totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
                firstOutputMs: firstModelOutputMs,
                promptBuildMs
              })
              if (!(await persistReply('stopped'))) return false
              publish('chat:done', { requestId, aborted: true })
              return false
            }
            const message = err instanceof Error ? err.message : 'Chat failed'
            persistRun({ status: 'failed', error: message })
            logError('Chat stream failed', {
              requestId,
              model: resolvedModel,
              error: message,
              totalMs: externalPlanningDurationMs + Date.now() - requestReceivedAt,
              firstOutputMs: firstModelOutputMs,
              promptBuildMs
            })
            publish('chat:error', {
              requestId,
              error: message
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
    } catch (error) {
      const stopped = error instanceof Error && error.name === 'AbortError'
      finishChatJob(payload.requestId, stopped ? 'stopped' : 'failed')
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
