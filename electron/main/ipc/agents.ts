import { ipcMain } from 'electron'
import { getResolvedSettings } from '../services/settings'
import { routeMessage } from '../services/router'
import { planChatTurn } from '../services/chat-router'
import type { ChatIntent, ProjectAgentsConfig } from '../../../src/shared/settings-schema'
import { recordRoutingCorrection } from '../services/routing-feedback'
import {
  getProjectAgents,
  listResolvedAgents,
  saveProjectAgents,
  seedProjectAgents
} from '../services/agents'
import { logInfo } from '../services/logger'
import { appState } from '../app-state'
import { getSecret } from './shared'

export function registerAgentsIpc(): void {
  ipcMain.handle(
    'agents:route',
    async (
      _e,
      payload: { text: string; fileNames: string[]; manualAgentId?: string | null }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      return routeMessage({
        workspacePath: appState.currentWorkspace,
        settings,
        text: payload.text,
        fileNames: payload.fileNames ?? [],
        manualAgentId: payload.manualAgentId
      })
    }
  )

  ipcMain.handle(
    'chat:planTurn',
    async (
      _e,
      payload: {
        text: string
        fileNames?: string[]
        manualAgentId?: string | null
        selectedModel: string
        mode?: 'ask' | 'agent'
        forceRoute?: 'tools' | 'answer'
      }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      const plan = await planChatTurn({
        workspacePath: appState.currentWorkspace,
        settings,
        context: {
          text: payload.text,
          fileNames: payload.fileNames ?? [],
          manualAgentId: payload.manualAgentId,
          selectedModel: payload.selectedModel,
          mode: payload.mode === 'ask' ? 'ask' : 'agent',
          forceRoute:
            payload.forceRoute === 'tools' || payload.forceRoute === 'answer'
              ? payload.forceRoute
              : undefined
        },
        getSecret
      })
      logInfo('Turn plan', {
        intent: plan.intent,
        classifiedIntent: plan.classifiedIntent,
        agentId: plan.agentId,
        method: plan.method,
        toolPolicy: plan.toolPolicy,
        chat: plan.models.chat,
        tools: plan.models.tools,
        error: plan.error
      })
      return plan
    }
  )

  ipcMain.handle(
    'routing:feedback',
    (
      _e,
      payload: { text: string; from: ChatIntent; to: 'tools' | 'answer'; agentId: string }
    ) => {
      if (payload.to !== 'tools' && payload.to !== 'answer') return false
      recordRoutingCorrection({
        text: String(payload.text || ''),
        from: payload.from,
        to: payload.to,
        agentId: String(payload.agentId || '')
      })
      logInfo('Routing correction', { from: payload.from, to: payload.to, agentId: payload.agentId })
      return true
    }
  )

  ipcMain.handle('agents:list', () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    return listResolvedAgents(appState.currentWorkspace, settings)
  })

  ipcMain.handle('agents:getProject', () => {
    if (appState.currentWorkspace) seedProjectAgents(appState.currentWorkspace, false)
    return getProjectAgents(appState.currentWorkspace)
  })

  ipcMain.handle('agents:saveProject', (_e, config: ProjectAgentsConfig) => {
    if (!appState.currentWorkspace) {
      throw new Error('Open a workspace to edit project agents')
    }
    return saveProjectAgents(appState.currentWorkspace, config)
  })

  ipcMain.handle('agents:resetProject', () => {
    if (!appState.currentWorkspace) {
      throw new Error('Open a workspace to reset project agents')
    }
    return seedProjectAgents(appState.currentWorkspace, true)
  })
}
