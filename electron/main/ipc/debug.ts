import { z } from 'zod'
import { isWorkspaceTrusted } from '../services/workspace-trust'
import { ipcMain } from 'electron'
import {
  debugAdapterCapabilities,
  debugVariables,
  debugEvaluate,
  debugExceptions,
  debugContinue,
  debugStepInto,
  debugStepOut,
  debugStepOver,
  getDebugState,
  listBreakpoints,
  listLaunchConfigs,
  onDebugState,
  saveBreakpoints,
  saveLaunchConfigs,
  startDebug,
  stopDebug,
  type LaunchConfig
} from '../services/debug-service'
import { appState } from '../app-state'

export function registerDebugIpc(): void {
  const owned = (event: Electron.IpcMainInvokeEvent, requireTrust = true) => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized debugger window/frame')
    if (
      !appState.currentWorkspace ||
      (requireTrust && !isWorkspaceTrusted(appState.currentWorkspace))
    )
      throw new Error('Trust the workspace before using debugger processes')
    return appState.currentWorkspace
  }
  ipcMain.handle('debug:capabilities', (event) => {
    owned(event, false)
    return debugAdapterCapabilities()
  })
  ipcMain.handle('debug:variables', (event) => {
    owned(event)
    return debugVariables()
  })
  ipcMain.handle('debug:evaluate', (event, raw: unknown) => {
    owned(event)
    return debugEvaluate(z.string().min(1).max(2000).parse(raw))
  })
  ipcMain.handle('debug:exceptions', (event, raw: unknown) => {
    owned(event)
    return debugExceptions(z.array(z.string().max(128)).max(32).parse(raw))
  })

  ipcMain.handle('debug:listConfigs', () => {
    if (!appState.currentWorkspace) return []
    return listLaunchConfigs(appState.currentWorkspace)
  })

  ipcMain.handle('debug:saveConfigs', (event, configs: LaunchConfig[]) => {
    owned(event)
    if (!Array.isArray(configs) || configs.length > 64 || JSON.stringify(configs).length > 1000000)
      throw new Error('Invalid debug configuration list')
    if (!appState.currentWorkspace) throw new Error('No workspace')
    saveLaunchConfigs(appState.currentWorkspace, configs)
    return listLaunchConfigs(appState.currentWorkspace)
  })

  ipcMain.handle('debug:listBreakpoints', () => {
    if (!appState.currentWorkspace) return []
    return listBreakpoints(appState.currentWorkspace)
  })

  ipcMain.handle(
    'debug:saveBreakpoints',
    (event, bps: Array<{ id: string; path: string; line: number; enabled: boolean }>) => {
      owned(event)
      if (!appState.currentWorkspace) throw new Error('No workspace')
      saveBreakpoints(appState.currentWorkspace, bps)
      return listBreakpoints(appState.currentWorkspace)
    }
  )

  ipcMain.handle('debug:state', () => getDebugState())

  ipcMain.handle('debug:start', async (event, configId: string, activeFile?: string | null) => {
    owned(event)
    z.string().min(1).max(128).parse(configId)
    z.string().max(4096).nullable().optional().parse(activeFile)
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const configs = listLaunchConfigs(appState.currentWorkspace)
    const config = configs.find((c) => c.id === configId)
    if (!config) throw new Error('No launch configuration')
    return startDebug({
      workspacePath: appState.currentWorkspace,
      config,
      activeFile: activeFile ?? null
    })
  })

  ipcMain.handle('debug:stop', (event) => {
    owned(event, false)
    return stopDebug()
  })
  ipcMain.handle('debug:continue', (event) => {
    owned(event)
    return debugContinue()
  })
  ipcMain.handle('debug:stepOver', (event) => {
    owned(event)
    return debugStepOver()
  })
  ipcMain.handle('debug:stepInto', (event) => {
    owned(event)
    return debugStepInto()
  })
  ipcMain.handle('debug:stepOut', (event) => {
    owned(event)
    return debugStepOut()
  })

  // Push debug state updates to all windows
  onDebugState((state) => {
    if (appState.mainWindow && !appState.mainWindow.isDestroyed())
      appState.mainWindow.webContents.send('debug:state', state)
  })
}
