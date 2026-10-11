import { ipcMain, dialog } from 'electron'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  saveWorkspaceContext,
  setContextSummary
} from '../services/workspace-context'
import {
  discoverEmailSources,
  pullEmailContext,
  readPulledEmailContext
} from '../services/email-context'
import { appState } from '../app-state'

export function registerContextIpc(): void {
  ipcMain.handle('context:get', () => getWorkspaceContext(appState.currentWorkspace))
  ipcMain.handle('context:pin', () => formatWorkspaceContextPrompt(appState.currentWorkspace))
  ipcMain.handle('context:save', (_e, body: string) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit context')
    return saveWorkspaceContext(appState.currentWorkspace, String(body ?? ''))
  })
  ipcMain.handle('context:setSummary', (_e, summary: string) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit context')
    return setContextSummary(appState.currentWorkspace, String(summary ?? ''))
  })
  ipcMain.handle('context:appendNote', (_e, note: string) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit context')
    return appendContextNote(appState.currentWorkspace, String(note ?? ''))
  })

  ipcMain.handle('email:discoverSources', async (_e, emlFolder?: string) => {
    return discoverEmailSources(emlFolder)
  })

  ipcMain.handle('email:pickEmlFolder', async () => {
    if (!appState.mainWindow) return { ok: false, path: null as string | null }
    const result = await dialog.showOpenDialog(appState.mainWindow, {
      title: 'Choose folder of .eml exports',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, path: null as string | null }
    }
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle(
    'email:pull',
    async (
      _e,
      payload: {
        sourceId: string
        query?: string
        maxMessages?: number
        appendToContext?: boolean
      }
    ) => {
      return pullEmailContext(appState.currentWorkspace, {
        sourceId: payload.sourceId,
        query: payload.query,
        maxMessages: payload.maxMessages,
        appendToContext: payload.appendToContext
      })
    }
  )

  ipcMain.handle('email:readPulled', () => readPulledEmailContext(appState.currentWorkspace))
}
