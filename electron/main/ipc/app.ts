import { app, ipcMain, dialog, shell } from 'electron'
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
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Only http(s) URLs allowed' }
    await shell.openExternal(u)
    return { ok: true }
  })

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

  ipcMain.handle('telemetry:recordDiffDecision', async (_e, payload?: { kept?: number; undone?: number }) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    if (settings.general.telemetry?.agentOutcomes !== true) return false
    const { recordDiffDecision } = await import('../services/agent-telemetry')
    recordDiffDecision({ kept: payload?.kept, undone: payload?.undone })
    return true
  })
  ipcMain.handle('telemetry:get', async () => {
    const { getTelemetrySummaries } = await import('../services/agent-telemetry')
    return getTelemetrySummaries()
  })

  ipcMain.handle('usage:get', async (_e, days?: number, opts?: { refresh?: boolean }) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const {
      pullUsageFromProfile,
      getUsageSyncMeta,
      getRemoteUsageCache,
      getEffectiveTodayTotals,
      getEffectiveWindowTotals,
      getRemoteWindowTotals
    } = await import('../services/usage-sync')
    const { getLocalDayTotals, getLocalWindowTotals, USAGE_WINDOW_DAYS } = await import(
      '../services/usage-stats'
    )
    if (opts?.refresh !== false) {
      try {
        await pullUsageFromProfile()
      } catch {
        /* offline / unsigned */
      }
    }
    const snap = getUsageSnapshot(days ?? USAGE_WINDOW_DAYS)
    const day = snap.today.date
    const deviceToday = getLocalDayTotals(day)
    const remote = getRemoteUsageCache()
    const accountToday = remote
      ? {
          requests: remote.requests,
          inputTokens: remote.inputTokens,
          outputTokens: remote.outputTokens,
          cloudJobs: remote.cloudJobs
        }
      : null
    const eff = getEffectiveTodayTotals()
    const windowTotals = getEffectiveWindowTotals()
    const deviceWindow = getLocalWindowTotals()
    const accountWindow = getRemoteWindowTotals()
    const sync = getUsageSyncMeta()
    return {
      ...snap,
      window: {
        ...deviceWindow,
        requests: windowTotals.requests,
        inputTokens: windowTotals.inputTokens,
        outputTokens: windowTotals.outputTokens,
        cloudJobs: windowTotals.cloudJobs
      },
      entitlement: getUsageEntitlement(settings, getSecret),
      profile: {
        sync,
        deviceToday,
        accountToday,
        effectiveToday: {
          requests: eff.requests,
          inputTokens: eff.inputTokens,
          outputTokens: eff.outputTokens,
          cloudJobs: eff.cloudJobs
        },
        deviceWindow,
        accountWindow,
        effectiveWindow: {
          requests: windowTotals.requests,
          inputTokens: windowTotals.inputTokens,
          outputTokens: windowTotals.outputTokens,
          cloudJobs: windowTotals.cloudJobs
        }
      }
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
