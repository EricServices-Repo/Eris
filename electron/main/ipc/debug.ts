import { BrowserWindow, ipcMain } from 'electron'
import {
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
  ipcMain.handle('debug:listConfigs', () => {
    if (!appState.currentWorkspace) return []
    return listLaunchConfigs(appState.currentWorkspace)
  })

  ipcMain.handle('debug:saveConfigs', (_e, configs: LaunchConfig[]) => {
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
    (_e, bps: Array<{ id: string; path: string; line: number; enabled: boolean }>) => {
      if (!appState.currentWorkspace) throw new Error('No workspace')
      saveBreakpoints(appState.currentWorkspace, bps)
      return listBreakpoints(appState.currentWorkspace)
    }
  )

  ipcMain.handle('debug:state', () => getDebugState())

  ipcMain.handle('debug:start', async (_e, configId: string, activeFile?: string | null) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const configs = listLaunchConfigs(appState.currentWorkspace)
    const config = configs.find((c) => c.id === configId) || configs[0]
    if (!config) throw new Error('No launch configuration')
    return startDebug({
      workspacePath: appState.currentWorkspace,
      config,
      activeFile: activeFile ?? null
    })
  })

  ipcMain.handle('debug:stop', () => stopDebug())
  ipcMain.handle('debug:continue', () => debugContinue())
  ipcMain.handle('debug:stepOver', () => debugStepOver())
  ipcMain.handle('debug:stepInto', () => debugStepInto())
  ipcMain.handle('debug:stepOut', () => debugStepOut())

  // Push debug state updates to all windows
  onDebugState((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('debug:state', state)
    }
  })
}
