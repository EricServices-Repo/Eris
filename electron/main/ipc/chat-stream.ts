import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { planChatTurn, turnPlanToRouteResult } from '../services/chat-router'
import {
  commandNeedsApproval,
  denyAllPendingApprovals,
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
import { buildChatMessages } from '../services/chat-prompt'
import {
  loadLastAgentRun,
  loadResumableRun,
  saveAgentRun,
  setAgentRunStatus,
  type AgentRunRecord
} from '../services/agent-runs'
import {
  appendSessionStep,
  createAgentSession,
  listSessionSteps,
  loadAgentSession,
  loadSessionStep,
  saveAgentSession,
  setAgentSessionStatus
} from '../services/agent-sessions'
import { restoreCheckpointThrough } from '../services/checkpoints'
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
import {
  cloudInlineAvailable,
  runCloudAgentInline
} from '../services/cloud-agent-inline'
import { rememberAgentRun, rememberAskUserReply } from '../services/project-memory'

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
        turnPlan?: TurnPlan
        /** Active chat thread — used when orchestrator delegates specialists. */
        threadId?: string | null
      }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      const { requestId } = payload
      try {
        assertChatWithinPlan(settings, getSecret)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Plan limit reached'
        event.sender.send('chat:error', { requestId, error: message })
        return { ok: false, error: message }
      }
      appState.chatAbort?.abort()
      appState.chatAbort = new AbortController()
      appState.chatStreamActive = true
      appState.activeChatRequestId = payload.requestId
      // Ghost completes share the llama runtime — never race the agent turn.
      abortAllCompletes()
      const { model, agentId, mode } = payload
      const resumeRun = payload.prompt?.resumeRunId
        ? loadLastAgentRun(appState.currentWorkspace)
        : null
      const resume =
        resumeRun && resumeRun.id === payload.prompt?.resumeRunId ? resumeRun : null
      let resumeLoop:
        | {
            goal: string
            actionLog: string[]
            filesTouched: string[]
            workerMessages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
            fromStep?: number
          }
        | undefined
      if (resume && appState.currentWorkspace) {
        resumeLoop = {
          goal: resume.goal,
          actionLog: resume.actionLog,
          filesTouched: resume.filesTouched
        }
        const sessionId = resume.sessionId
        if (sessionId && loadAgentSession(appState.currentWorkspace, sessionId)) {
          const steps = listSessionSteps(appState.currentWorkspace, sessionId)
          const wantStep =
            typeof payload.prompt?.resumeSessionStep === 'number'
              ? payload.prompt.resumeSessionStep
              : steps.length
                ? steps[steps.length - 1]!.step
                : null
          const stepRec =
            wantStep != null
              ? loadSessionStep(appState.currentWorkspace, sessionId, wantStep)
              : null
          if (stepRec) {
            if (resume.checkpointId) {
              try {
                restoreCheckpointThrough(
                  appState.currentWorkspace,
                  resume.checkpointId,
                  stepRec.opThrough
                )
              } catch (err) {
                logWarn('Session rewind failed', {
                  sessionId,
                  step: stepRec.step,
                  error: err instanceof Error ? err.message : String(err)
                })
              }
            }
            resumeLoop = {
              goal: resume.goal,
              actionLog: stepRec.actionLog,
              filesTouched: stepRec.filesTouched,
              workerMessages: stepRec.workerMessages,
              fromStep: stepRec.step
            }
          }
        }
      }
      const messages = payload.prompt
        ? buildChatMessages(appState.currentWorkspace, settings, {
            ...payload.prompt,
            text: resume ? resume.goal : payload.prompt.text
          })
        : payload.messages ?? []
      const userText =
        resume?.goal ||
        payload.prompt?.text ||
        [...messages].reverse().find((m) => m.role === 'user')?.content.replace(/\n\n\[Eris\][\s\S]*$/, '') ||
        ''
      let turnPlan =
        payload.turnPlan ??
        (await planChatTurn({
          workspacePath: appState.currentWorkspace,
          settings,
          context: {
            text: userText,
            selectedModel: model || settings.models.defaultModel,
            mode: mode === 'ask' ? 'ask' : 'agent',
            manualAgentId: agentId ?? null
          },
          getSecret,
          signal: appState.chatAbort.signal
        }))
      const agent = findAgent(appState.currentWorkspace, turnPlan.agentId) ||
        (agentId ? findAgent(appState.currentWorkspace, agentId) : null)
      let resolvedModel = turnPlan.models.chat || model || settings.models.defaultModel
      const temperature =
        agent?.temperature ?? settings.models.temperature
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
          event.sender.send('chat:thinking', { requestId, chunk: pendingThinking })
          pendingThinking = ''
        }
        if (pendingAnswer) {
          event.sender.send('chat:answer', { requestId, chunk: pendingAnswer })
          pendingAnswer = ''
        }
      }
      const scheduleStreamFlush = () => {
        if (coalesceTimer) return
        coalesceTimer = setTimeout(flushStreamChunks, 40)
      }
      let run: AgentRunRecord | null = null
      let runIncomplete = false
      /** Accumulated for project memory even when no checkpoint/run record exists. */
      let memoryFiles: string[] = []
      let memoryActions: string[] = []
      // #10 opt-in agent telemetry
      const telemetryOn = settings.general.telemetry?.agentOutcomes === true
      let telemetrySteps = 0
      let telemetryMutated = false
      let usedCloud = false
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
        if (!run || !appState.currentWorkspace) return
        run = { ...run, ...patch }
        saveAgentRun(appState.currentWorkspace, run)
        if (run.sessionId && patch.status) {
          setAgentSessionStatus(appState.currentWorkspace, run.sessionId, patch.status)
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
          messages: messages.length
        })
        const route = turnPlanToRouteResult(turnPlan)
        event.sender.send('chat:routed', {
          requestId,
          agentId: route.agentId,
          agentName: route.agentName,
          model: resolvedModel,
          reason: turnPlan.reason,
          intent: turnPlan.intent,
          toolsModel: turnPlan.models.tools
        })
        pendingThinking += `Route: ${turnPlan.reason}${turnPlan.classifiedIntent && turnPlan.classifiedIntent !== turnPlan.intent ? ` (classified ${turnPlan.classifiedIntent})` : ''} · tools ${turnPlan.toolPolicy}\n`
        scheduleStreamFlush()

        const threadId = payload.threadId ?? null
        if (appState.currentWorkspace) {
          configureBackgroundAgents({ sender: event.sender, getSecret })
        }
        const chatChildIds: string[] = []
        const publishDelegations = () => {
          const terminal = new Set(['done', 'failed', 'stopped', 'merged', 'discarded'])
          for (const id of chatChildIds) {
            const job = getBackgroundJob(id)
            if (!job) continue
            const named = findAgent(appState.currentWorkspace, job.agentId)
            const failed = job.status === 'failed' || job.status === 'stopped' || job.status === 'discarded'
            event.sender.send('chat:delegation', {
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
                result: (job.answer || job.liveStatus || '').slice(0, 700)
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
          (mode ?? 'agent') === 'agent' &&
          turnPlan.mode === 'agent' &&
          Boolean(appState.currentWorkspace) &&
          usingComposerFull &&
          cloudPreferred &&
          !resume

        if (wantCloudInline && (await cloudInlineAvailable(settings, getSecret))) {
          try {
            assertCloudJobWithinPlan(settings, getSecret)
            usedCloud = true
            event.sender.send('chat:model', {
              requestId,
              model: 'composer',
              agentId: turnPlan.agentId,
              agentName: turnPlan.agentName
            })
            for await (const evt of runCloudAgentInline({
              workspacePath: appState.currentWorkspace!,
              settings,
              goal: userText,
              agentId: turnPlan.agentId,
              agentName: turnPlan.agentName,
              getSecret,
              signal: appState.chatAbort.signal
            })) {
              if (evt.type === 'thinking') {
                pendingThinking += evt.text
                scheduleStreamFlush()
              } else if (evt.type === 'answer') {
                pendingAnswer += evt.text
                scheduleStreamFlush()
              } else {
                flushStreamChunks()
                if (evt.type === 'tool') {
                  event.sender.send('chat:tool', { requestId, tool: evt.tool })
                } else if (evt.type === 'diff') {
                  telemetryMutated = true
                  event.sender.send('chat:diff', { requestId, diff: evt.diff })
                } else if (evt.type === 'checkpoint') {
                  event.sender.send('chat:checkpoint', {
                    requestId,
                    checkpointId: evt.checkpointId
                  })
                } else if (evt.type === 'workspace-changed') {
                  event.sender.send('chat:workspace-changed', { requestId })
                } else if (evt.type === 'status') {
                  event.sender.send('chat:status', { requestId, text: evt.text })
                } else if (evt.type === 'model') {
                  event.sender.send('chat:model', {
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
              const mem = rememberAgentRun(
                appState.currentWorkspace,
                getResolvedSettings(appState.currentWorkspace),
                {
                  goal: userText,
                  filesTouched: memoryFiles,
                  actionLog: memoryActions,
                  aborted: false
                }
              )
              if (mem.needsConfirm) {
                event.sender.send('chat:memory-proposal', {
                  requestId,
                  note: mem.note,
                  summary: mem.summary,
                  preview: mem.preview
                })
              } else if (mem.wrote) {
                event.sender.send('chat:memory-updated', {
                  requestId,
                  kind: mem.kind,
                  preview: mem.preview
                })
              }
            } catch {
              /* memory is best-effort */
            }
            event.sender.send('chat:done', { requestId })
            logInfo('Chat stream done (cloud inline)', { requestId })
            return true
          } catch (cloudErr) {
            if ((cloudErr as Error).name === 'AbortError') {
              flushStreamChunks()
              persistRun({ status: 'stopped' })
              event.sender.send('chat:done', { requestId, aborted: true })
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

        if (resolvedModel === 'builtin:composer' || resolvedModel === 'composer') {
          resolvedModel = 'builtin:composer-lite'
          turnPlan = {
            ...turnPlan,
            models: { ...turnPlan.models, chat: resolvedModel, tools: resolvedModel }
          }
        }

        for await (const evt of runAgentWithWorkspaceTools({
          workspacePath: appState.currentWorkspace,
          settings,
          model: resolvedModel,
          messages,
          temperature,
          signal: appState.chatAbort.signal,
          getSecret,
          mode: mode ?? 'agent',
          turnPlan,
          jobId: `chat:${requestId}`,
          resume: resumeLoop,
          onDelegate: async (req) => {
            if (!appState.currentWorkspace) {
              return { ok: false, detail: 'Open a workspace to delegate' }
            }
            try {
              const child = delegateFromAgent({
                workspacePath: appState.currentWorkspace,
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
              event.sender.send('chat:status', {
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
            event.sender.send('chat:status', { requestId, text: 'Waiting for delegated agents…' })
            while (Date.now() < deadline) {
              if (appState.chatAbort?.signal.aborted) {
                publishDelegations()
                return { ok: false, detail: 'Aborted while waiting for children' }
              }
              publishDelegations()
              const children = chatChildIds.map((id) => getBackgroundJob(id)).filter(Boolean)
              const pending = children.filter((c) => c && !terminal.has(c.status))
              if (pending.length === 0) {
                const detail = children
                  .map((c) =>
                    c
                      ? `### ${c.agentName || c.agentId} · ${c.status}\n${c.answer.trim().slice(0, 800) || '(no answer)'}`
                      : ''
                  )
                  .filter(Boolean)
                  .join('\n\n')
                return { ok: true, detail: detail || 'Children finished' }
              }
              await new Promise((r) => setTimeout(r, 500))
            }
            return { ok: false, detail: 'Timed out waiting for delegated children' }
          },
          approveCommand: async (kind, command) => {
            const live = getResolvedSettings(appState.currentWorkspace)
            const workspaceAllowed = workspaceAllowedCommands(appState.currentWorkspace)
            if (!commandNeedsApproval(live, kind, command, workspaceAllowed)) return true
            flushStreamChunks()
            const decision = await requestCommandApproval(
              event.sender,
              requestId,
              kind,
              command,
              appState.chatAbort?.signal
            )
            logInfo('Command approval', { requestId, kind, command, decision })
            if (decision === 'always') {
              if (appState.currentWorkspace) {
                addWorkspaceAllowedCommand(appState.currentWorkspace, normalizeCommand(command))
              } else {
                const allowed = [
                  ...new Set([...live.agent.allowedCommands, normalizeCommand(command)])
                ]
                setSettings('user', { agent: { allowedCommands: allowed } }, null)
              }
            }
            return decision !== 'deny'
          },
          askUser: async (question, choices) => {
            flushStreamChunks()
            const outcome = await requestUserQuestion(event.sender, requestId, question, {
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
                appState.currentWorkspace,
                getResolvedSettings(appState.currentWorkspace),
                question,
                outcome.text
              )
              if (mem.needsConfirm) {
                event.sender.send('chat:memory-proposal', {
                  requestId,
                  note: mem.note,
                  summary: mem.summary,
                  preview: mem.preview
                })
              } else if (mem.wrote) {
                event.sender.send('chat:memory-updated', {
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
          if (evt.type === 'thinking') {
            pendingThinking += evt.text
            scheduleStreamFlush()
          } else if (evt.type === 'answer') {
            pendingAnswer += evt.text
            scheduleStreamFlush()
          } else {
            flushStreamChunks()
            if (evt.type === 'tool') {
              event.sender.send('chat:tool', { requestId, tool: evt.tool })
            } else if (evt.type === 'diff') {
              telemetryMutated = true
              event.sender.send('chat:diff', { requestId, diff: evt.diff })
            } else if (evt.type === 'checkpoint') {
              event.sender.send('chat:checkpoint', {
                requestId,
                checkpointId: evt.checkpointId
              })
              if (appState.currentWorkspace) {
                const now = new Date().toISOString()
                let sessionId = resume?.sessionId ?? null
                if (sessionId && loadAgentSession(appState.currentWorkspace, sessionId)) {
                  const existing = loadAgentSession(appState.currentWorkspace, sessionId)!
                  saveAgentSession(appState.currentWorkspace, {
                    ...existing,
                    requestId,
                    checkpointId: evt.checkpointId,
                    status: 'running'
                  })
                } else {
                  const session = createAgentSession(appState.currentWorkspace, {
                    requestId,
                    threadId,
                    goal: userText,
                    agentId: turnPlan.agentId,
                    mode: mode ?? 'agent',
                    checkpointId: evt.checkpointId
                  })
                  sessionId = session.id
                }
                run = {
                  id: resume?.id ?? requestId,
                  requestId,
                  goal: userText,
                  agentId: turnPlan.agentId,
                  mode: mode ?? 'agent',
                  checkpointId: evt.checkpointId,
                  sessionId,
                  status: 'running',
                  step: resumeLoop?.fromStep ?? resume?.step ?? 0,
                  actionLog: resumeLoop?.actionLog ?? resume?.actionLog ?? [],
                  filesTouched: resumeLoop?.filesTouched ?? resume?.filesTouched ?? [],
                  startedAt: resume?.startedAt ?? now,
                  updatedAt: now
                }
                persistRun({})
                event.sender.send('chat:session', {
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
              if (run?.sessionId && appState.currentWorkspace) {
                appendSessionStep(appState.currentWorkspace, run.sessionId, {
                  step: evt.step,
                  opThrough: evt.opThrough,
                  summary: evt.summary,
                  actionLog: evt.actionLog,
                  filesTouched: evt.filesTouched,
                  workerMessages: evt.workerMessages
                })
                event.sender.send('chat:session-step', {
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
              event.sender.send('chat:terminal', { requestId, text: evt.text })
            } else if (evt.type === 'workspace-changed') {
              event.sender.send('chat:workspace-changed', { requestId })
            } else if (evt.type === 'status') {
              event.sender.send('chat:status', { requestId, text: evt.text })
            } else if (evt.type === 'delegation') {
              event.sender.send('chat:delegation', { requestId, delegation: evt.delegation })
            } else if (evt.type === 'adapt') {
              event.sender.send('chat:status', {
                requestId,
                text: evt.reason
              })
              if (evt.model) {
                event.sender.send('chat:model', {
                  requestId,
                  model: evt.model,
                  agentId: evt.agentId ?? agent?.id ?? agentId,
                  agentName: evt.agentName ?? agent?.name
                })
              }
            } else if (evt.type === 'model') {
              event.sender.send('chat:model', {
                requestId,
                model: evt.model,
                agentId: agent?.id ?? agentId,
                agentName: agent?.name
              })
            }
          }
        }
        flushStreamChunks()
        persistRun({ status: runIncomplete ? 'incomplete' : 'done' })
        recordTelemetry(runIncomplete ? 'incomplete' : 'done')
        try {
          const mem = rememberAgentRun(
            appState.currentWorkspace,
            getResolvedSettings(appState.currentWorkspace),
            {
              goal: userText,
              filesTouched: memoryFiles.length
                ? memoryFiles
                : (run?.filesTouched ?? []),
              actionLog: memoryActions.length
                ? memoryActions
                : (run?.actionLog ?? []),
              incomplete: runIncomplete,
              aborted: false
            }
          )
          if (mem.needsConfirm) {
            event.sender.send('chat:memory-proposal', {
              requestId,
              note: mem.note,
              summary: mem.summary,
              preview: mem.preview
            })
          } else if (mem.wrote) {
            event.sender.send('chat:memory-updated', {
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
        event.sender.send('chat:done', { requestId })
        logInfo('Chat stream done', { requestId, model: resolvedModel })
        return true
      } catch (err) {
        flushStreamChunks()
        if ((err as Error).name === 'AbortError') {
          persistRun({ status: 'stopped' })
          recordTelemetry('aborted')
          logWarn('Chat stream aborted', { requestId })
          event.sender.send('chat:done', { requestId, aborted: true })
          return false
        }
        const message = err instanceof Error ? err.message : 'Chat failed'
        persistRun({ status: 'failed', error: message })
        logError('Chat stream failed', { requestId, model: resolvedModel, error: message })
        event.sender.send('chat:error', {
          requestId,
          error: message
        })
        // Don't rethrow — returning keeps the renderer invoke from rejecting as an unhandled crash
        return false
      } finally {
        if (coalesceTimer) clearTimeout(coalesceTimer)
        setDiagnosticsPaused(false)
        appState.chatStreamActive = false
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

  ipcMain.handle('runs:resumable', () => {
    const run = loadResumableRun(
      appState.currentWorkspace,
      appState.chatStreamActive ? appState.activeChatRequestId : null
    )
    if (!run) return null
    const steps =
      run.sessionId && appState.currentWorkspace
        ? listSessionSteps(appState.currentWorkspace, run.sessionId)
        : []
    return {
      id: run.id,
      goal: run.goal,
      agentId: run.agentId,
      status: run.status,
      step: run.step,
      actionLog: run.actionLog,
      updatedAt: run.updatedAt,
      sessionId: run.sessionId ?? null,
      checkpointId: run.checkpointId,
      steps
    }
  })
  ipcMain.handle('runs:dismiss', (_e, id: string) => {
    const ok = setAgentRunStatus(appState.currentWorkspace, String(id), 'dismissed')
    const run = loadLastAgentRun(appState.currentWorkspace)
    if (run?.sessionId) {
      setAgentSessionStatus(appState.currentWorkspace, run.sessionId, 'dismissed')
    }
    return ok
  })
  ipcMain.handle('sessions:listSteps', (_e, sessionId: string) =>
    listSessionSteps(appState.currentWorkspace, String(sessionId))
  )
  ipcMain.handle('sessions:get', (_e, sessionId: string) =>
    loadAgentSession(appState.currentWorkspace, String(sessionId))
  )

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
