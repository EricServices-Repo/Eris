import { ipcMain } from 'electron'
import {
  checkForUpdates,
  dismissUpdateBanner,
  downloadUpdate,
  getUpdateStatus,
  installUpdateNow,
  openReleasesPage
} from '../services/auto-update'

export function registerUpdatesIpc(): void {
  ipcMain.handle('updates:getStatus', () => getUpdateStatus())
  ipcMain.handle('updates:check', (_e, silent?: boolean) =>
    checkForUpdates({ silent: Boolean(silent) })
  )
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:install', () => {
    installUpdateNow()
    return { ok: true }
  })
  ipcMain.handle('updates:openReleases', () => openReleasesPage())
  ipcMain.handle('updates:dismiss', () => {
    dismissUpdateBanner()
    return { ok: true }
  })
}
