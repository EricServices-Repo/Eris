import { ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import {
  openWorkspaceDialog,
  rememberWorkspace,
  getWorkspaceMeta,
  setWorkspaceMeta,
  listWorkspaces,
  createWorkspaceDialog,
  linkWorkspaceDialog,
  getWorkspaceById,
  renameWorkspace,
  removeWorkspace
} from '../services/workspace'
import { listTree, readTextFile, writeTextFile, languageFromPath } from '../services/files'
import { setWorkspaceFsChangeHandler, stopWorkspaceWatcher } from '../services/workspace-watcher'
import { notifyWorkspaceFilesChanged } from '../services/code-index'
import { invalidateDiagnosticsCache } from '../services/diagnostics'
import { logInfo, logWarn } from '../services/logger'
import { isPathInside, realpathAllowMissing } from '../services/workspace-fs'
import { userDataRoot } from '../services/paths'
import type { WorkspaceMeta } from '../../../src/shared/settings-schema'
import { appState } from '../app-state'
import { refreshIntelligence } from './shared'
import { getWorkspaceSettings, invalidateResolvedSettingsCache } from '../services/settings'
import {
  isWorkspaceTrusted,
  riskyWorkspaceSettings,
  setWorkspaceTrusted
} from '../services/workspace-trust'

/** Files the user chose in the import dialog (readable even outside the workspace). */
const pickedFiles = new Set<string>()

/** Renderer file access is limited to the open workspace and Eris's own data folder. */
function assertRendererPathAllowed(path: string, mode: 'read' | 'write'): void {
  if (typeof path !== 'string' || !path) throw new Error('Invalid path')
  const ws = appState.currentWorkspace
  if (ws && isPathInside(ws, path)) return
  if (isPathInside(userDataRoot(), path)) return
  if (mode === 'read' && pickedFiles.has(realpathAllowMissing(path))) return
  logWarn('Blocked renderer file access', { path, mode })
  throw new Error(`Access outside the workspace is not allowed: ${path}`)
}

export function registerWorkspaceIpc(): void {
  setWorkspaceFsChangeHandler(({ workspacePath, path, paths }) => {
    invalidateDiagnosticsCache()
    const changed = paths?.length ? paths : path ? [path] : undefined
    notifyWorkspaceFilesChanged(workspacePath, changed)
    if (appState.mainWindow && !appState.mainWindow.isDestroyed()) {
      appState.mainWindow.webContents.send('workspace:fs-changed', {
        workspacePath,
        path: path || changed?.[0] || '',
        paths: changed
      })
    }
  })

  ipcMain.handle('workspace:list', () => listWorkspaces())

  ipcMain.handle('workspace:create', async (_e, name: string) => {
    if (!appState.mainWindow) return null
    const record = await createWorkspaceDialog(appState.mainWindow, name)
    if (record) {
      setWorkspaceTrusted(record.path, true)
      appState.currentWorkspace = record.path
      refreshIntelligence()
    }
    return record
  })

  ipcMain.handle('workspace:link', async (_e, name?: string) => {
    if (!appState.mainWindow) return null
    const record = await linkWorkspaceDialog(appState.mainWindow, name)
    if (record) {
      appState.currentWorkspace = record.path
      refreshIntelligence()
    }
    return record
  })

  ipcMain.handle('workspace:open', async () => {
    if (!appState.mainWindow) return null
    const path = await openWorkspaceDialog(appState.mainWindow)
    if (path) {
      appState.currentWorkspace = path
      refreshIntelligence()
    }
    return path
  })

  ipcMain.handle('workspace:openPath', (_e, path: string) => {
    if (!existsSync(path)) return null
    appState.currentWorkspace = path
    rememberWorkspace(path)
    refreshIntelligence()
    return path
  })

  ipcMain.handle('workspace:openById', (_e, id: string) => {
    const record = getWorkspaceById(id)
    if (!record || !existsSync(record.path)) return null
    appState.currentWorkspace = record.path
    const remembered = rememberWorkspace(record.path, { id: record.id, name: record.name })
    logInfo('Workspace opened', { id, path: record.path, name: record.name })
    refreshIntelligence()
    return remembered
  })

  ipcMain.handle('workspace:rename', (_e, id: string, name: string) => renameWorkspace(id, name))

  ipcMain.handle('workspace:remove', (_e, id: string) => {
    const record = getWorkspaceById(id)
    const state = removeWorkspace(id)
    if (record && appState.currentWorkspace === record.path) {
      appState.currentWorkspace = null
      stopWorkspaceWatcher()
    }
    return state
  })

  ipcMain.handle('workspace:getCurrent', () => appState.currentWorkspace)

  ipcMain.handle('workspace:setCurrent', (_e, path: string | null) => {
    appState.currentWorkspace = path
    if (path) rememberWorkspace(path)
    refreshIntelligence()
    return appState.currentWorkspace
  })

  ipcMain.handle('workspace:trustStatus', () => {
    const ws = appState.currentWorkspace
    if (!ws) return { workspacePath: null, trusted: false, risky: [] as string[] }
    return {
      workspacePath: ws,
      trusted: isWorkspaceTrusted(ws),
      risky: riskyWorkspaceSettings(getWorkspaceSettings(ws))
    }
  })

  ipcMain.handle('workspace:setTrust', (_e, trusted: boolean) => {
    const ws = appState.currentWorkspace
    if (!ws) return false
    setWorkspaceTrusted(ws, Boolean(trusted))
    invalidateResolvedSettingsCache()
    logInfo('Workspace trust changed', { path: ws, trusted: Boolean(trusted) })
    refreshIntelligence()
    return true
  })

  ipcMain.handle('workspace:getMeta', (_e, path: string) => getWorkspaceMeta(path))
  ipcMain.handle('workspace:setMeta', (_e, path: string, meta: WorkspaceMeta) =>
    setWorkspaceMeta(path, meta)
  )

  ipcMain.handle('fs:listTree', (_e, root: string) => {
    assertRendererPathAllowed(root, 'read')
    return listTree(root)
  })
  ipcMain.handle('fs:read', (_e, path: string) => {
    assertRendererPathAllowed(path, 'read')
    const file = readTextFile(path)
    return { ...file, language: languageFromPath(path) }
  })
  ipcMain.handle('fs:write', (_e, path: string, content: string) => {
    assertRendererPathAllowed(path, 'write')
    writeTextFile(path, content)
    return true
  })
  ipcMain.handle('fs:pickFiles', async () => {
    if (!appState.mainWindow) return [] as string[]
    const result = await dialog.showOpenDialog(appState.mainWindow, {
      title: 'Import files for agent',
      properties: ['openFile', 'multiSelections'],
      defaultPath: appState.currentWorkspace ?? undefined
    })
    if (result.canceled) return [] as string[]
    for (const p of result.filePaths) pickedFiles.add(realpathAllowMissing(p))
    return result.filePaths
  })
}
