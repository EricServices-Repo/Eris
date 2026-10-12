import { ipcMain } from 'electron'
import {
  appendContextNote,
  formatWorkspaceContextPrompt,
  getWorkspaceContext,
  resetWorkspaceContext,
  saveWorkspaceContext,
  setContextSummary
} from '../services/workspace-context'
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
  ipcMain.handle('context:reset', () => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit context')
    return resetWorkspaceContext(appState.currentWorkspace)
  })
}
