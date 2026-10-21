import { appendTaskEvent, flushTaskLedger } from '../services/task-ledger'
import { reviewTaskOutcome } from '../services/task-outcome'
import { asksForImageGeneration } from '../../../src/shared/image-generation'
import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import {
  planChatTurn,
  turnPlanToRouteResult,
  localComposerFullActive
} from '../services/chat-router'
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
import type { ChatPromptInput, TurnPlan } from '../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS, summarizeAgentResults } from '../../../src/shared/agent-orchestration'
import { previousTask, saveTask } from '../services/task-store'
import { realpathSync } from 'fs'
import { resolveTaskIntent } from '../services/task-resolver'
import { createTaskContract } from '../services/task-intake'
import { buildChatMessages } from '../services/chat-prompt'
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
  getChatJob,
  recordChatJobEvent,
  startChatJob
} from '../services/chat-job-controller'

export function registerChatStreamIpc(): void {
  ipcMain.handle(
    'chat:stream',
    async (
      event,
      payload: {
        requestId: string
        model: string
        /** Legacy pre-assembled messages; prefer `prompt`. */
        messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
        prompt?: ChatPromptInput
        agentId?: string
        mode?: 'ask' | 'agent'
        workspacePath?: string | null
        forceRoute?: 'tools' | 'answer'
        turnPlan?: TurnPlan
        planningDurationMs?: number
        /** Active chat thread — used when orchestrator delegates specialists. */
        threadId?: string | null
      }
    ) => {
      const workspacePath = appState.currentWorkspace
      if (payload.workspacePath !== undefined && payload.workspacePath !== workspacePath) {
        event.sender.send('chat:error', {
          requestId: payload.requestId,
          error:
            'The workspace changed before submission. Send the message again in the intended project.'
        })
        return false
      }
      if (getChatJob(payload.requestId)) return true
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
      const publish = (channel: string, data: Record<string, unknown>): void => {
        recordChatJobEvent(requestId, channel, data)
        if (['chat:task', 'chat:evidence', 'chat:outcome'].includes(channel))
          appendTaskEvent(requestId, channel, data)
        const target = chatSender()
        if (!target.isDestroyed()) target.send(channel, data)
        if (channel === 'chat:done') {
          finishChatJob(
            requestId,
            data.aborted ? 'stopped' : data.incomplete ? 'incomplete' : 'done'
          )
        } else if (channel === 'chat:error') {
          finishChatJob(requestId, 'failed')
          void flushTaskLedger(requestId)
        }
      }
      try {
        assertChatWithinPlan(settings, getSecret)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Plan limit reached'
        publish('chat:error', { requestId, error: message })
        return false
      }
      appState.chatAbort?.abort()
      const controller = new AbortController()
      appState.chatAbort = controller
      appState.chatStreamActive = true
      appState.activeChatRequestId = payload.requestId
      // Ghost completes share the llama runtime — never race the agent turn.
      abortAllCompletes()
      const { model, agentId, mode } = payload
      let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
      // Resolve the route before generating role instructions. A renderer route can
      // be corrected below, so its original agent must never own the final prompt.
      messages = payload.prompt
        ? [
            ...payload.prompt.history.map(({ role, content }) => ({ role, content })),
            { role: 'user', content: payload.prompt.text }
          ]
        : (payload.messages ?? [])
      let promptBuildMs = 0
      const userText =
        payload.prompt?.text ||
        [...messages]
          .reverse()
          .find((m) => m.role === 'user')
          ?.content.replace(/\n\n\[Eris\][\s\S]*$/, '') ||
        ''
      startChatJob({
        id: requestId,
        workspacePath: workspacePath,
        threadId: payload.threadId ?? payload.prompt?.threadId ?? null,
        goal: userText
      })
      const previousAgentId =
        [...(payload.prompt?.history ?? [])]
          .reverse()
          .find((message) => message.role === 'assistant')?.agentId ?? null
      let planningDurationMs = payload.planningDurationMs
      let turnPlan: TurnPlan
      try {
        {
          const planningStartedAt = Date.now()
          turnPlan = await planChatTurn({
            workspacePath: workspacePath,
            settings,
            context: {
              text: userText,
              selectedModel: model || settings.models.defaultModel,
              mode: mode === 'ask' ? 'ask' : 'agent',
              manualAgentId: agentId ?? null,
              previousAgentId,
              skipModelRouter: true,
              forceRoute: payload.forceRoute,
              previousMessages: payload.prompt?.history.flatMap((message) =>
                message.role === 'system'
                  ? []
                  : [{ role: message.role, content: message.content, agentId: message.agentId }]
              )
            },
            getSecret,
            signal: controller.signal
          })
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
        const semanticIntent = payload.forceRoute
          ? turnPlan.intent
          : await resolveTaskIntent({
              text: userText,
              fallback: turnPlan.intent,
              settings,
              model: turnPlan.models.chat,
              mode: mode ?? 'agent',
              history: payload.prompt?.history,
              signal: controller.signal,
              getSecret
            })
        if (semanticIntent !== turnPlan.intent) {
          turnPlan = await planChatTurn({
            workspacePath,
            settings,
            context: {
              text: userText,
              mode: mode ?? 'agent',
              selectedModel: model,
              manualAgentId: agentId ?? null,
              resolvedIntent: semanticIntent,
              skipModelRouter: true,
              previousMessages: payload.prompt?.history.flatMap((message) =>
                message.role === 'system'
                  ? []
                  : [{ role: message.role, content: message.content, agentId: message.agentId }]
              )
            },
            getSecret,
            signal: controller.signal
          })
        }
        const taskThreadId = payload.threadId ?? payload.prompt?.threadId ?? null
        let canonicalRoot = workspacePath
        try {
          if (workspacePath) canonicalRoot = realpathSync(workspacePath)
        } catch {
          /* reported by runtime */
        }
        turnPlan.task = createTaskContract({
          taskId: requestId,
          threadId: payload.threadId ?? payload.prompt?.threadId,
          workspacePath,
          text: userText,
          plan: turnPlan,
          skillIds: payload.prompt?.skillIds,
          history: payload.prompt?.history,
          priorTask: previousTask(canonicalRoot, taskThreadId)
        })
        saveTask(turnPlan.task)
        publish('chat:task', { requestId, task: turnPlan.task })
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
      const promptBuildStartedAt = Date.now()
      try {
        if (payload.prompt) {
          messages = buildChatMessages(workspacePath, settings, {
            ...payload.prompt,
            mode: turnPlan.mode,
            agentId: turnPlan.agentId,
            agentName: turnPlan.agentName,
            threadId: payload.threadId ?? payload.prompt.threadId
          })
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
      const outcomeEvidence: string[] = []
      /** Accumulated for project memory even when no checkpoint/run record exists. */
      let memoryFiles: string[] = []
      let memoryActions: string[] = []
      // #10 opt-in agent telemetry
      const telemetryOn = settings.general.telemetry?.agentOutcomes === true
      let telemetrySteps = 0
      let telemetryMutated = false
      let usedCloud = false
      let firstModelOutputMs: number | null = null
      const noteFirstModelOutput = (evt: { type: string; text?: string }) => {
        const hasOutput = (evt.type === 'thinking' || evt.type === 'answer') && Boolean(evt.text)
        if (firstModelOutputMs !== null || (!hasOutput && evt.type !== 'tool')) {
          return
        }
        firstModelOutputMs = externalPlanningDurationMs + Date.now() - requestReceivedAt
        logInfo('Chat first model output', {
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

        if (
          wantCloudInline &&
          (await cloudInlineAvailable(settings, getSecret, turnPlan.task?.version))
        ) {
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
              noteFirstModelOutput(evt)
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

        if (
          (resolvedModel === 'builtin:composer' || resolvedModel === 'composer') &&
          !localComposerFullActive(settings)
        ) {
          resolvedModel = 'builtin:composer-lite'
          turnPlan = {
            ...turnPlan,
            models: { ...turnPlan.models, chat: resolvedModel, tools: resolvedModel }
          }
        }

        for await (const evt of runAgentWithWorkspaceTools({
          workspacePath: workspacePath,
          settings,
          model: resolvedModel,
          messages,
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
            publish('chat:status', { requestId, text: 'Waiting for delegated agents…' })
            while (Date.now() < deadline) {
              if (appState.chatAbort?.signal.aborted) {
                publishDelegations()
                return { ok: false, detail: 'Aborted while waiting for children' }
              }
              publishDelegations()
              const children = chatChildIds.map((id) => getBackgroundJob(id)).filter(Boolean)
              const pending = children.filter((c) => c && !terminal.has(c.status))
              if (pending.length === 0) {
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
            const decision = await requestCommandApproval(
              chatSender(),
              requestId,
              kind,
              command,
              appState.chatAbort?.signal
            )
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
            const decision = await requestCommandApproval(
              chatSender(),
              requestId,
              'mcp',
              preview,
              appState.chatAbort?.signal,
              { toolName, canAlwaysAllow: false }
            )
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
          noteFirstModelOutput(evt)
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
              if (
                evt.tool.status !== 'running' &&
                ['read_file', 'notebook_read', 'run', 'search_replace', 'write_file'].includes(
                  evt.tool.name
                )
              )
                outcomeEvidence.push(
                  `${evt.tool.name} ${evt.tool.path ?? ''}: ${evt.tool.status}\n${evt.tool.detail}`
                )
              publish('chat:tool', { requestId, tool: evt.tool })
            } else if (evt.type === 'diff') {
              outcomeEvidence.push(
                `Observed diff ${evt.diff.path}:\nBefore: ${(evt.diff.before ?? '').slice(0, 600)}\nAfter: ${(evt.diff.after ?? '').slice(0, 900)}`
              )
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
        if (
          !runIncomplete &&
          turnPlan.task &&
          ['review', 'plan', 'edit', 'verify', 'run'].includes(turnPlan.intent)
        ) {
          publish('chat:status', {
            requestId,
            text: 'Checking the response against task evidence…'
          })
          if (memoryActions.length) outcomeEvidence.push(memoryActions.slice(-15).join('\n'))
          const verdict = await reviewTaskOutcome({
            task: turnPlan.task,
            answer: finalAnswer,
            evidence: outcomeEvidence,
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
    }
  )

  ipcMain.handle(
    'chat:approvalRespond',
    (_e, approvalId: string, decision: CommandApprovalDecision) =>
      resolveCommandApproval(
        approvalId,
        decision === 'allow' || decision === 'always' ? decision : 'deny'
      )
  )

  ipcMain.handle('chat:questionRespond', (_e, questionId: string, reply: string | null) =>
    resolveUserQuestion(String(questionId), reply == null ? null : String(reply))
  )

  ipcMain.handle('sessions:listSteps', (_e, sessionId: string) =>
    listSessionSteps(appState.currentWorkspace, String(sessionId))
  )
  ipcMain.handle('sessions:get', (_e, sessionId: string) =>
    loadAgentSession(appState.currentWorkspace, String(sessionId))
  )
  ipcMain.handle('chat:jobLatest', () => getLatestChatJob(appState.currentWorkspace))

  ipcMain.handle('chat:stop', () => {
    if (appState.activeChatRequestId) {
      denyAllPendingApprovals(appState.activeChatRequestId)
      cancelAllPendingQuestions(appState.activeChatRequestId)
    }
    if (appState.chatAbort) {
      appState.chatAbort.abort()
      // Keep the controller so in-flight code still sees signal.aborted === true.
      // A new stream replaces it on the next chat:stream.
    }
    return true
  })
}
