import { app, ipcMain, dialog } from 'electron'
import { getAppState, completeOnboarding, resetOnboarding } from '../services/workspace'
import { clearUsageStats, getUsageSnapshot } from '../services/usage-stats'
import { getUsageEntitlement } from '../services/eris-entitlements'
import { getResolvedSettings } from '../services/settings'
import {
  clearLogs,
  getLogsInfo,
  log,
  logInfo,
  openLogsDirectory,
  readLogFile,
  type LogLevel
} from '../services/logger'
import { appState } from '../app-state'
import { getSecret, storeSecret } from './shared'

export function registerAppIpc(): void {
  ipcMain.handle('app:getState', () => getAppState())
  ipcMain.handle('app:getVersion', () => ({
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged
  }))
  ipcMain.handle('app:completeOnboarding', () => completeOnboarding())
  ipcMain.handle('app:resetOnboarding', () => resetOnboarding())

  ipcMain.handle('logs:info', () => getLogsInfo())
  ipcMain.handle('logs:read', (_e, fileName?: string) => readLogFile({ fileName }))
  ipcMain.handle('logs:clear', () => {
    const result = clearLogs()
    logInfo('Logs cleared', result)
    return result
  })
  ipcMain.handle('logs:openFolder', () => openLogsDirectory())
  ipcMain.handle('logs:pickDirectory', async () => {
    if (!appState.mainWindow) return null
    const result = await dialog.showOpenDialog(appState.mainWindow, {
      title: 'Choose log folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getLogsInfo().directory
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle(
    'logs:write',
    (_e, level: LogLevel, message: string, meta?: unknown) => {
      log(level, message, meta)
      return true
    }
  )

  ipcMain.handle('secrets:set', (_e, key: string, value: string) => {
    storeSecret(key, value)
    return true
  })
  ipcMain.handle('secrets:get', (_e, key: string) => getSecret(key))

  ipcMain.handle('usage:get', (_e, days?: number) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const snap = getUsageSnapshot(days ?? 7)
    return {
      ...snap,
      entitlement: getUsageEntitlement(settings, getSecret)
    }
  })
  ipcMain.handle('usage:clear', (_e, payload?: { todayOnly?: boolean }) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const snap = clearUsageStats({ todayOnly: Boolean(payload?.todayOnly) })
    return {
      ...snap,
      entitlement: getUsageEntitlement(settings, getSecret)
    }
  })
}
