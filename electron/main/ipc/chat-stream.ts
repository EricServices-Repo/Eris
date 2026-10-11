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
import type { ChatPromptInput, TurnPlan } from '../../../src/shared/settings-schema'
import { buildChatMessages } from '../services/chat-prompt'
import {
  loadLastAgentRun,
  loadResumableRun,
  saveAgentRun,
  setAgentRunStatus,
  type AgentRunRecord
} from '../services/agent-runs'
import { runAgentWithWorkspaceTools } from '../services/agent-runner'
import { setDiagnosticsPaused } from '../services/diagnostics'
import { findAgent } from '../services/agents'
import { logError, logInfo, logWarn } from '../services/logger'
import { appState } from '../app-state'
import { getSecret, abortAllCompletes } from './shared'
import { addWorkspaceAllowedCommand, workspaceAllowedCommands } from '../services/workspace-trust'

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
      }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      appState.chatAbort?.abort()
      appState.chatAbort = new AbortController()
      appState.chatStreamActive = true
      appState.activeChatRequestId = payload.requestId
      // Ghost completes share the llama runtime — never race the agent turn.
      abortAllCompletes()
      const { requestId, model, agentId, mode } = payload
      const resumeRun = payload.prompt?.resumeRunId
        ? loadLastAgentRun(appState.currentWorkspace)
        : null
      const resume =
        resumeRun && resumeRun.id === payload.prompt?.resumeRunId ? resumeRun : null
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
      const turnPlan =
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
      const resolvedModel = turnPlan.models.chat || model || settings.models.defaultModel
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
      const persistRun = (patch: Partial<AgentRunRecord>) => {
        if (!run || !appState.currentWorkspace) return
        run = { ...run, ...patch }
        saveAgentRun(appState.currentWorkspace, run)
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
          resume: resume
            ? {
                goal: resume.goal,
                actionLog: resume.actionLog,
                filesTouched: resume.filesTouched
              }
            : undefined,
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
              event.sender.send('chat:diff', { requestId, diff: evt.diff })
            } else if (evt.type === 'checkpoint') {
              event.sender.send('chat:checkpoint', {
                requestId,
                checkpointId: evt.checkpointId
              })
              if (appState.currentWorkspace) {
                const now = new Date().toISOString()
                run = {
                  id: resume?.id ?? requestId,
                  requestId,
                  goal: userText,
                  agentId: turnPlan.agentId,
                  mode: mode ?? 'agent',
                  checkpointId: evt.checkpointId,
                  status: 'running',
                  step: resume?.step ?? 0,
                  actionLog: resume?.actionLog ?? [],
                  filesTouched: resume?.filesTouched ?? [],
                  startedAt: resume?.startedAt ?? now,
                  updatedAt: now
                }
                persistRun({})
              }
            } else if (evt.type === 'progress') {
              if (evt.incomplete) runIncomplete = true
              persistRun({
                step: evt.step,
                actionLog: evt.actionLog.slice(-120),
                filesTouched: [...new Set(evt.filesTouched)].slice(-200)
              })
            } else if (evt.type === 'terminal') {
              event.sender.send('chat:terminal', { requestId, text: evt.text })
            } else if (evt.type === 'workspace-changed') {
              event.sender.send('chat:workspace-changed', { requestId })
            } else if (evt.type === 'status') {
              event.sender.send('chat:status', { requestId, text: evt.text })
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
        event.sender.send('chat:done', { requestId })
        logInfo('Chat stream done', { requestId, model: resolvedModel })
        return true
      } catch (err) {
        flushStreamChunks()
        if ((err as Error).name === 'AbortError') {
          persistRun({ status: 'stopped' })
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

  ipcMain.handle('runs:resumable', () =>
    loadResumableRun(appState.currentWorkspace, appState.chatStreamActive ? appState.activeChatRequestId : null)
  )
  ipcMain.handle('runs:dismiss', (_e, id: string) =>
    setAgentRunStatus(appState.currentWorkspace, String(id), 'dismissed')
  )

  ipcMain.handle('chat:stop', () => {
    if (appState.activeChatRequestId) denyAllPendingApprovals(appState.activeChatRequestId)
    if (appState.chatAbort) {
      appState.chatAbort.abort()
      // Keep the controller so in-flight code still sees signal.aborted === true.
      // A new stream replaces it on the next chat:stream.
    }
    return true
  })
}
