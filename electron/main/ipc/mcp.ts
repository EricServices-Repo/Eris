import { ipcMain } from 'electron'
import { getResolvedSettings } from '../services/settings'
import { getMcpStatuses, listMcpTools, syncMcpRuntime } from '../services/mcp-runtime'
import { appState } from '../app-state'

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:status', async () => {
    if (appState.currentWorkspace) {
      await syncMcpRuntime(getResolvedSettings(appState.currentWorkspace), appState.currentWorkspace).catch(
        () => undefined
      )
    }
    return {
      servers: getMcpStatuses(),
      tools: listMcpTools()
    }
  })

  ipcMain.handle('mcp:reconnect', async () => {
    if (!appState.currentWorkspace) return { servers: [], tools: [] }
    await syncMcpRuntime(getResolvedSettings(appState.currentWorkspace), appState.currentWorkspace)
    return { servers: getMcpStatuses(), tools: listMcpTools() }
  })
}
