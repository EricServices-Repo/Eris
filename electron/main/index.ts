import { app, BrowserWindow } from 'electron'
import { getResolvedSettings, stripLegacySubagentsFromUserSettings } from './services/settings'
import { startAutoUpdates } from './services/auto-update'
import { stopWorkspaceWatcher } from './services/workspace-watcher'
import { disposeMcpRuntime } from './services/mcp-runtime'
import { resolveLoginShellPath } from './services/workspace-env'
import { setDiagnosticsPaused } from './services/diagnostics'
import { disposePtySession } from './services/pty-session'
import { disposeLanguageServers } from './services/language-servers'
import { stopAllBackgroundJobs } from './services/background-agents'
import { cancelEvalRun } from './services/eval-runner'
import { disposeRuntime } from './services/builtin-model'
import { configureLogger, logInfo, logWarn } from './services/logger'
import { appState } from './app-state'
import { createWindow, resolveAppIcon } from './window'
import { buildMenu } from './menu'
import { registerIpc } from './ipc'

// macOS may deliver files dropped on the Dock/icon; never load them into the shell.
app.on('open-file', (event) => {
  event.preventDefault()
})

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.eris.ide')
  }

  const icon = resolveAppIcon()
  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  try {
    stripLegacySubagentsFromUserSettings()
  } catch {
    // ignore migrate errors
  }

  try {
    configureLogger(getResolvedSettings(null))
    logInfo('Eris started', { version: app.getVersion(), packaged: app.isPackaged })
  } catch (err) {
    // logger may still work with defaults
    logWarn('Logger configure failed at launch', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  registerIpc()
  buildMenu()
  createWindow()
  startAutoUpdates(() => appState.mainWindow)

  // Warm login-shell PATH off the critical path (Dock launches omit Homebrew/nvm).
  setImmediate(() => {
    try {
      resolveLoginShellPath()
    } catch {
      // ignore
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  appState.chatAbort?.abort()
  appState.chatAbort = null
  cancelEvalRun()
  void stopAllBackgroundJobs()
  setDiagnosticsPaused(false)
  stopWorkspaceWatcher()
  disposePtySession()
  void disposeLanguageServers().catch(() => undefined)
  void disposeMcpRuntime().catch(() => undefined)
  void disposeRuntime()
    .catch(() => undefined)
    .finally(() => {
      app.exit(0)
    })
})
