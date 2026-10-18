import { stopLocalImageProcesses } from './services/local-image-model'
import { setDefaultResultOrder } from 'dns'
import { app, BrowserWindow, protocol } from 'electron'
import { registerImageProtocol } from './ipc/images'

protocol.registerSchemesAsPrivileged([{ scheme: 'eris-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Windows/Node undici: prefer IPv4 so HTTPS downloads do not die with opaque "fetch failed".
try {
  setDefaultResultOrder('ipv4first')
} catch {
  // ignore
}
import {
  getResolvedSettings,
  migrateLegacyConnectionTypesInUserSettings,
  stripLegacySubagentsFromUserSettings
} from './services/settings'
import { startAutoUpdates } from './services/auto-update'
import { stopWorkspaceWatcher } from './services/workspace-watcher'
import { disposeMcpRuntime } from './services/mcp-runtime'
import { warmLoginShellPath } from './services/workspace-env'
import { setDiagnosticsPaused } from './services/diagnostics'
import { disposePtySession } from './services/pty-session'
import { disposeLanguageServers } from './services/language-servers'
import { stopAllBackgroundJobs } from './services/background-agents'
import { cancelEvalRun } from './services/eval-runner'
import { disposeRuntime } from './services/builtin-model'
import { disposeWorkspaceWorkers } from './services/workspace-worker-client'
import { configureLogger, logInfo, logWarn } from './services/logger'
import { appState } from './app-state'
import { createWindow, resolveAppIcon } from './window'
import { buildMenu } from './menu'
import { registerIpc } from './ipc'

// Never touch the OS Keychain — secrets live in userData/secrets.json only.
// Must run before ready; Chromium otherwise uses Keychain for cookie/OSCrypt.
app.commandLine.appendSwitch('password-store', 'basic')
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain')
}

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
    migrateLegacyConnectionTypesInUserSettings()
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

  registerImageProtocol()
  registerIpc()
  buildMenu()
  createWindow()
  startAutoUpdates(() => appState.mainWindow)

  // Warm login-shell PATH in the background (never block IPC — zsh -ilc can take seconds).
  setImmediate(() => {
    try {
      warmLoginShellPath()
    } catch {
      // ignore
    }
  })

  // Idle-warm default local GGUF after UI is up (first chat shouldn't cold-load).
  setTimeout(() => {
    void import('./services/builtin-model')
      .then(({ warmLocalInference }) => warmLocalInference(getResolvedSettings(null)))
      .catch(() => undefined)
  }, 2_500)

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
  stopLocalImageProcesses()
  void stopAllBackgroundJobs()
  setDiagnosticsPaused(false)
  stopWorkspaceWatcher()
  disposePtySession()
  void disposeLanguageServers().catch(() => undefined)
  void disposeMcpRuntime().catch(() => undefined)
  void Promise.all([disposeRuntime(), disposeWorkspaceWorkers()])
    .catch(() => undefined)
    .finally(() => {
      app.exit(0)
    })
})
