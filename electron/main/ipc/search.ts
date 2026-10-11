import { ipcMain } from 'electron'
import { buildCodeIndexAsync, findReferences, findSymbols, relatedFiles } from '../services/code-index'
import { retrieveContextAsync, workspaceGlob, workspaceGrep } from '../services/workspace-search'
import { appState } from '../app-state'

export function registerSearchIpc(): void {
  ipcMain.handle(
    'search:grep',
    async (_e, pattern: string, glob?: string) => {
      if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
      return workspaceGrep(appState.currentWorkspace, pattern, { glob })
    }
  )

  ipcMain.handle('search:glob', (_e, pattern: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return workspaceGlob(appState.currentWorkspace, pattern)
  })

  ipcMain.handle('search:symbols', (_e, query: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return findSymbols(appState.currentWorkspace, query)
  })
  ipcMain.handle('search:references', (_e, name: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', hits: [] }
    return findReferences(appState.currentWorkspace, name)
  })
  ipcMain.handle('search:related', (_e, path: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return relatedFiles(appState.currentWorkspace, path)
  })

  ipcMain.handle('search:retrieve', async (_e, query: string) => {
    if (!appState.currentWorkspace) return { ok: false, detail: 'No workspace', paths: [] }
    return retrieveContextAsync(appState.currentWorkspace, query)
  })

  ipcMain.handle('index:rebuild', async () => {
    if (!appState.currentWorkspace) return { ok: false, files: 0, symbols: 0 }
    const record = await buildCodeIndexAsync(appState.currentWorkspace)
    return { ok: true, files: record.files.length, symbols: record.symbols.length }
  })
}
