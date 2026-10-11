import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { logInfo, logWarn } from './logger'

const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let started = false
let manualCheck = false

/** Background update checks against GitHub Releases (packaged builds only). */
export function startAutoUpdates(getWindow: () => BrowserWindow | null): void {
  if (started || !app.isPackaged || process.env.ERIS_DISABLE_UPDATES === '1') return
  started = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => logInfo('Update available', { version: info.version }))
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'info',
        message: 'Eris is up to date',
        detail: `Version ${app.getVersion()}`
      })
    }
  })
  autoUpdater.on('error', (err) => {
    // Unsigned builds cannot install updates (Squirrel.Mac requires a signature).
    logWarn('Auto-update error', { error: err?.message ?? String(err) })
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Could not check for updates',
        detail: err?.message ?? String(err)
      })
    }
  })
  autoUpdater.on('update-downloaded', async (info) => {
    manualCheck = false
    logInfo('Update downloaded', { version: info.version })
    const win = getWindow()
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Eris ${info.version} is ready to install`,
      detail: 'Restart to finish updating. Otherwise it installs the next time you quit.'
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    if (response === 0) autoUpdater.quitAndInstall()
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      logWarn('Update check failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS)
}

export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    void dialog.showMessageBox({
      type: 'info',
      message: 'Updates are only available in packaged builds.'
    })
    return
  }
  manualCheck = true
  autoUpdater.checkForUpdates().catch(() => {
    // surfaced via the 'error' listener
  })
}
