import { spawnSync } from 'child_process'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { logInfo, logWarn } from './logger'
import { getResolvedSettings } from './settings'

/**
 * Public update feed (no client token). Source stays private in EricServices-Repo/Eris;
 * installers + latest-*.yml are mirrored to EricServices-Repo/Eris-updates.
 */
export const ERIS_RELEASES_URL = 'https://github.com/EricServices-Repo/Eris-updates/releases/latest'
export const ERIS_RELEASES_REPO = 'EricServices-Repo/Eris-updates'
const UPDATE_OWNER = 'EricServices-Repo'
const UPDATE_REPO = 'Eris-updates'

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
  /**
   * macOS without Developer ID: Squirrel cannot install in-place.
   * Clients should open the Releases page instead of downloading via updater.
   */
  manualInstallOnly?: boolean
}

type GetWindow = () => BrowserWindow | null

let getWindow: GetWindow = () => null
let started = false
let checkTimer: ReturnType<typeof setInterval> | null = null
let manualCheck = false
let lastCheckedAt: string | undefined
let macSigningChecked = false
let macInPlaceUpdates = process.platform !== 'darwin'

let snapshot: UpdateStatusSnapshot = {
  state: 'idle',
  currentVersion: app.getVersion(),
  canOpenReleases: true,
  autoCheck: true,
  autoDownload: true,
  packaged: app.isPackaged,
  manualInstallOnly: false
}

/**
 * Squirrel.Mac requires a Developer ID signature. Ad-hoc / unsigned local and CI
 * builds always fail at download/install — detect that and use Releases instead.
 */
function macSupportsInPlaceUpdates(): boolean {
  if (process.platform !== 'darwin') return true
  if (macSigningChecked) return macInPlaceUpdates
  macSigningChecked = true
  const res = spawnSync('codesign', ['-dv', '--verbose=4', process.execPath], {
    encoding: 'utf8',
    timeout: 8_000
  })
  const msg = `${res.stderr || ''}\n${res.stdout || ''}\n${res.error?.message || ''}`
  macInPlaceUpdates = /Authority=Developer ID Application/i.test(msg)
  logInfo('macOS update signing check', { inPlaceUpdates: macInPlaceUpdates })
  return macInPlaceUpdates
}

function manualInstallOnly(): boolean {
  return process.platform === 'darwin' && !macSupportsInPlaceUpdates()
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
  const manualOnly = manualInstallOnly()
  snapshot = {
    ...snapshot,
    ...partial,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    autoCheck: prefs.autoCheck,
    // Never auto-download on unsigned Mac — Squirrel will error and scare the user
    autoDownload: manualOnly ? false : prefs.autoDownload,
    canOpenReleases: true,
    manualInstallOnly: manualOnly
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

function friendlyUpdateError(message: string): string {
  if (/app-update\.yml|ENOENT/i.test(message)) {
    return (
      'Update configuration is missing from this build. ' +
      'Quit Eris completely and reopen the rebuilt app, or download an installer from Releases.'
    )
  }
  if (/404|Not Found|Unable to find latest version|CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND/i.test(message)) {
    return (
      'No update metadata found on the public Eris-updates feed yet. ' +
      'Open Releases to download an installer manually.'
    )
  }
  if (/401|403|Bad credentials|Unauthorized|rate.?limit/i.test(message)) {
    return 'GitHub rate-limited or rejected the update check. Try again in a few minutes, or open Releases.'
  }
  if (/code.?sign|Squirrel\.Mac|not signed|identity|Gatekeeper/i.test(message)) {
    return (
      'This build is not code-signed, so macOS cannot install updates in-place. ' +
      'Download the latest installer from GitHub Releases.'
    )
  }
  return message
}

function applyFeedPrefs(): void {
  const prefs = readUpdatePrefs()
  const manualOnly = manualInstallOnly()
  autoUpdater.autoDownload = manualOnly ? false : prefs.autoDownload
  autoUpdater.autoInstallOnAppQuit = !manualOnly
}

/** Public GitHub Releases — no PAT required on clients. */
function configureUpdateFeed(): void {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
    releaseType: 'release'
  })
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
  configureUpdateFeed()
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => {
    publish({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logInfo('Update available', { version: info.version, manualInstallOnly: manualInstallOnly() })
    publish({
      state: 'available',
      availableVersion: info.version,
      releaseName: info.releaseName || `Eris v${info.version}`,
      releaseNotes: notesToString(info.releaseNotes),
      lastCheckedAt: new Date().toISOString(),
      error: undefined
    })
    lastCheckedAt = snapshot.lastCheckedAt
    if (manualCheck) {
      const win = getWindow()
      if (manualInstallOnly()) {
        const box = {
          type: 'info' as const,
          buttons: ['Open releases', 'Later'],
          defaultId: 0,
          cancelId: 1,
          message: `Eris ${info.version} is available`,
          detail:
            'This Mac build is not Developer ID–signed, so updates cannot install in-place. ' +
            'Download the .dmg / .zip from GitHub Releases and replace Eris in Applications.'
        }
        void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
          .then(({ response }) => {
            manualCheck = false
            if (response === 0) void openReleasesPage()
          })
          .catch(() => {
            manualCheck = false
          })
        return
      }
      if (!readUpdatePrefs().autoDownload) {
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
    const raw = err?.message ?? String(err)
    const isSignError = /code.?sign|Squirrel\.Mac|not signed|identity|Gatekeeper/i.test(raw)
    // Unsigned Mac + Squirrel noise: don't alarm if we already know manual install is required
    if (isSignError && manualInstallOnly()) {
      logWarn('Auto-update skipped (unsigned Mac)', { error: raw })
      publish({
        state: snapshot.availableVersion ? 'available' : 'idle',
        error: undefined,
        manualInstallOnly: true
      })
      if (manualCheck) {
        manualCheck = false
        void dialog
          .showMessageBox({
            type: 'info',
            buttons: ['Open releases', 'OK'],
            defaultId: 0,
            cancelId: 1,
            message: 'Install from GitHub Releases',
            detail:
              'This Mac build is not Developer ID–signed, so Eris cannot update itself in-place. ' +
              `Download the latest installer:\n${ERIS_RELEASES_URL}`
          })
          .then(({ response }) => {
            if (response === 0) void openReleasesPage()
          })
          .catch(() => {})
      }
      return
    }
    const message = friendlyUpdateError(raw)
    logWarn('Auto-update error', { error: raw })
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
            `Release installers: ${ERIS_RELEASES_URL}`
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
  const manualOnly = manualInstallOnly()
  return {
    ...snapshot,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    autoCheck: prefs.autoCheck,
    autoDownload: manualOnly ? false : prefs.autoDownload,
    manualInstallOnly: manualOnly
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
  configureUpdateFeed()
  lastCheckedAt = new Date().toISOString()
  publish({ state: 'checking', lastCheckedAt })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const message = friendlyUpdateError(raw)
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
  if (manualInstallOnly()) {
    await openReleasesPage()
    publish({
      state: 'available',
      error: undefined,
      manualInstallOnly: true
    })
    return getUpdateStatus()
  }
  try {
    publish({ state: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    publish({ state: 'error', error: friendlyUpdateError(raw) })
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
