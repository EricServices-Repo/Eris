import { app, dialog, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { logInfo, logWarn } from './logger'
import { getResolvedSettings } from './settings'

/** Public GitHub Releases page (website can deep-link here too). */
export const ERIS_RELEASES_URL = 'https://github.com/EricServices-Repo/Eris/releases/latest'
export const ERIS_RELEASES_REPO = 'EricServices-Repo/Eris'

const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdateState =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatusSnapshot {
  state: UpdateState
  currentVersion: string
  availableVersion?: string
  releaseName?: string
  /** Plain-text / markdown release notes from GitHub when present */
  releaseNotes?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  /** True when the user can fall back to a manual download */
  canOpenReleases: boolean
  autoCheck: boolean
  autoDownload: boolean
  packaged: boolean
  lastCheckedAt?: string
}

type GetWindow = () => BrowserWindow | null

let getWindow: GetWindow = () => null
let started = false
let checkTimer: ReturnType<typeof setInterval> | null = null
let manualCheck = false
let lastCheckedAt: string | undefined
let snapshot: UpdateStatusSnapshot = {
  state: 'idle',
  currentVersion: app.getVersion(),
  canOpenReleases: true,
  autoCheck: true,
  autoDownload: true,
  packaged: app.isPackaged
}

function readUpdatePrefs(): { autoCheck: boolean; autoDownload: boolean } {
  try {
    const g = getResolvedSettings(null).general.updates
    return {
      autoCheck: g?.autoCheck !== false,
      autoDownload: g?.autoDownload !== false
    }
  } catch {
    return { autoCheck: true, autoDownload: true }
  }
}

function publish(partial: Partial<UpdateStatusSnapshot>): void {
  const prefs = readUpdatePrefs()
  snapshot = {
    ...snapshot,
    ...partial,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    autoCheck: prefs.autoCheck,
    autoDownload: prefs.autoDownload,
    canOpenReleases: true
  }
  const win = getWindow()
  win?.webContents.send('updates:status', snapshot)
}

function notesToString(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n.note || '')).filter(Boolean).join('\n\n')
  }
  return undefined
}

function applyFeedPrefs(): void {
  const prefs = readUpdatePrefs()
  autoUpdater.autoDownload = prefs.autoDownload
  autoUpdater.autoInstallOnAppQuit = true
}

/** Background + manual update checks against GitHub Releases (packaged builds). */
export function startAutoUpdates(getWin: GetWindow): void {
  getWindow = getWin
  if (started) return
  started = true

  snapshot.currentVersion = app.getVersion()
  snapshot.packaged = app.isPackaged

  if (!app.isPackaged || process.env.ERIS_DISABLE_UPDATES === '1') {
    publish({
      state: 'disabled',
      error: app.isPackaged
        ? 'Updates disabled (ERIS_DISABLE_UPDATES=1)'
        : 'Updates only run in packaged builds'
    })
    return
  }

  applyFeedPrefs()
  autoUpdater.logger = null
  // GitHub Releases provider is embedded via package.json build.publish

  autoUpdater.on('checking-for-update', () => {
    publish({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logInfo('Update available', { version: info.version })
    publish({
      state: 'available',
      availableVersion: info.version,
      releaseName: info.releaseName || `Eris v${info.version}`,
      releaseNotes: notesToString(info.releaseNotes),
      lastCheckedAt: new Date().toISOString()
    })
    lastCheckedAt = snapshot.lastCheckedAt
    if (manualCheck && !readUpdatePrefs().autoDownload) {
      const win = getWindow()
      const box = {
        type: 'info' as const,
        buttons: ['Download', 'Later', 'Open releases'],
        defaultId: 0,
        cancelId: 1,
        message: `Eris ${info.version} is available`,
        detail: 'Download now, or open the GitHub releases page for a manual installer.'
      }
      void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
        .then(({ response }) => {
          if (response === 0) void downloadUpdate()
          if (response === 2) void openReleasesPage()
        })
        .catch(() => {})
    }
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    lastCheckedAt = new Date().toISOString()
    publish({
      state: 'not-available',
      availableVersion: info.version,
      lastCheckedAt
    })
    if (manualCheck) {
      manualCheck = false
      void dialog.showMessageBox({
        type: 'info',
        message: 'Eris is up to date',
        detail: `Version ${app.getVersion()}`
      })
    }
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    publish({
      state: 'downloading',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total
    })
  })

  autoUpdater.on('update-downloaded', async (info: UpdateInfo) => {
    manualCheck = false
    logInfo('Update downloaded', { version: info.version })
    publish({
      state: 'downloaded',
      availableVersion: info.version,
      releaseName: info.releaseName || `Eris v${info.version}`,
      releaseNotes: notesToString(info.releaseNotes)
    })
    const win = getWindow()
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Eris ${info.version} is ready to install`,
      detail:
        'Restart to finish updating. Otherwise it installs the next time you quit the app.'
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    if (response === 0) installUpdateNow()
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    logWarn('Auto-update error', { error: message })
    publish({ state: 'error', error: message })
    if (manualCheck) {
      manualCheck = false
      void dialog
        .showMessageBox({
          type: 'warning',
          buttons: ['Open releases', 'OK'],
          defaultId: 0,
          cancelId: 1,
          message: 'Could not update automatically',
          detail:
            `${message}\n\n` +
            'Packaged updates need a signed build and GitHub release assets ' +
            '(latest-mac.yml / latest.yml). You can download the installer manually.'
        })
        .then(({ response }) => {
          if (response === 0) void openReleasesPage()
        })
        .catch(() => {})
    }
  })

  const prefs = readUpdatePrefs()
  publish({ state: 'idle', lastCheckedAt })

  if (prefs.autoCheck) {
    setTimeout(() => {
      void checkForUpdates({ silent: true })
    }, FIRST_CHECK_DELAY_MS)
    checkTimer = setInterval(() => {
      if (readUpdatePrefs().autoCheck) void checkForUpdates({ silent: true })
    }, CHECK_INTERVAL_MS)
  }
}

export function getUpdateStatus(): UpdateStatusSnapshot {
  const prefs = readUpdatePrefs()
  return {
    ...snapshot,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    autoCheck: prefs.autoCheck,
    autoDownload: prefs.autoDownload
  }
}

export async function checkForUpdates(options?: {
  silent?: boolean
}): Promise<UpdateStatusSnapshot> {
  if (!app.isPackaged || process.env.ERIS_DISABLE_UPDATES === '1') {
    publish({
      state: 'disabled',
      error: !app.isPackaged
        ? 'Updates only run in packaged builds'
        : 'Updates disabled (ERIS_DISABLE_UPDATES=1)'
    })
    if (!options?.silent) {
      void dialog.showMessageBox({
        type: 'info',
        message: 'Updates are only available in packaged builds.',
        detail: `Current version ${app.getVersion()}. Open GitHub Releases to download installers.`
      })
    }
    return getUpdateStatus()
  }

  manualCheck = !options?.silent
  applyFeedPrefs()
  lastCheckedAt = new Date().toISOString()
  publish({ state: 'checking', lastCheckedAt })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    publish({ state: 'error', error: message, lastCheckedAt })
    if (manualCheck) {
      manualCheck = false
      void dialog
        .showMessageBox({
          type: 'warning',
          buttons: ['Open releases', 'OK'],
          defaultId: 0,
          cancelId: 1,
          message: 'Could not check for updates',
          detail: message
        })
        .then(({ response }) => {
          if (response === 0) void openReleasesPage()
        })
        .catch(() => {})
    }
  }
  return getUpdateStatus()
}

/** Menu / IPC entry used by “Check for Updates…” */
export function checkForUpdatesNow(): void {
  void checkForUpdates({ silent: false })
}

export async function downloadUpdate(): Promise<UpdateStatusSnapshot> {
  if (snapshot.state !== 'available' && snapshot.state !== 'error') {
    return getUpdateStatus()
  }
  try {
    publish({ state: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    publish({ state: 'error', error: message })
  }
  return getUpdateStatus()
}

export function installUpdateNow(): void {
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    publish({ state: 'error', error: message })
    void openReleasesPage()
  }
}

export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(ERIS_RELEASES_URL)
}

export function dismissUpdateBanner(): void {
  if (snapshot.state === 'available' || snapshot.state === 'downloaded' || snapshot.state === 'error') {
    publish({ state: 'idle', error: undefined, percent: undefined })
  }
}

export function stopAutoUpdateTimers(): void {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}
