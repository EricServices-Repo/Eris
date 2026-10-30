import { credentialStore } from '../services/credential-store'
import { contextMemoryStore } from '../services/context-memory-store'
import { ipcMain } from 'electron'
import {
  getLayeredSettings,
  getResolvedSettings,
  setSettings,
  resetSettingKey
} from '../services/settings'
import { configureLogger, logInfo } from '../services/logger'
import type { SettingsPatch, SettingsScope } from '../../../src/shared/settings-schema'
import { appState } from '../app-state'
import { refreshIntelligence } from './shared'

export function registerSettingsIpc(): void {
  ipcMain.handle('credentials:status', (event) => {
    if (appState.mainWindow && event.sender !== appState.mainWindow.webContents)
      throw new Error('Unauthorized sender')
    return credentialStore.status()
  })
  ipcMain.handle('credentials:policy', (event, policy: unknown) => {
    if (appState.mainWindow && event.sender !== appState.mainWindow.webContents)
      throw new Error('Unauthorized sender')
    if (policy !== 'local' && policy !== 'vault') throw new Error('Invalid credential policy')
    credentialStore.select(policy)
    return credentialStore.status()
  })

  ipcMain.handle('settings:getLayered', () => getLayeredSettings(appState.currentWorkspace))
  ipcMain.handle('settings:getResolved', () => getResolvedSettings(appState.currentWorkspace))
  ipcMain.handle('settings:set', (_e, scope: SettingsScope, patch: SettingsPatch) => {
    const next = setSettings(scope, patch, appState.currentWorkspace)
    contextMemoryStore.configure(getResolvedSettings(null).agent.contextMemory)
    if (patch.mcp) refreshIntelligence()
    configureLogger(next)
    logInfo('Settings updated', { scope, keys: Object.keys(patch) })
    return next
  })
  ipcMain.handle('settings:resetKey', (_e, scope: SettingsScope, pathKeys: string[]) => {
    const next = resetSettingKey(scope, pathKeys, appState.currentWorkspace)
    contextMemoryStore.configure(getResolvedSettings(null).agent.contextMemory)
    configureLogger(next)
    return next
  })
}
