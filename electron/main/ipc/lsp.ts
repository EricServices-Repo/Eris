import { ipcMain } from 'electron'
import { collectDiagnostics, goToDefinition, languageHover } from '../services/diagnostics'
import { runVerify } from '../services/verify'
import {
  lspCompletion,
  lspDefinition,
  lspDidChange,
  lspDidClose,
  lspDidOpen,
  lspHover,
  onLspDiagnostics
} from '../services/ts-lsp'
import { appState } from '../app-state'

export function registerLspIpc(): void {
  onLspDiagnostics((items) => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed() || !items.length) return
    const path = items[0]!.path
    appState.mainWindow.webContents.send('lsp:diagnostics', { path, diagnostics: items })
  })

  ipcMain.handle(
    'lsp:didOpen',
    async (
      _e,
      payload: { path: string; language: string; text: string }
    ) => {
      if (!appState.currentWorkspace) return { ok: false }
      await lspDidOpen(appState.currentWorkspace, payload.path, payload.language, payload.text)
      return { ok: true }
    }
  )
  ipcMain.handle(
    'lsp:didChange',
    async (
      _e,
      payload: { path: string; language: string; text: string }
    ) => {
      if (!appState.currentWorkspace) return { ok: false }
      await lspDidChange(appState.currentWorkspace, payload.path, payload.language, payload.text)
      return { ok: true }
    }
  )
  ipcMain.handle('lsp:didClose', async (_e, path: string) => {
    await lspDidClose(path)
    return { ok: true }
  })
  ipcMain.handle(
    'lsp:hover',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, contents: '' }
      return lspHover(
        appState.currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )
  ipcMain.handle(
    'lsp:definition',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, locations: [] }
      return lspDefinition(
        appState.currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )
  ipcMain.handle(
    'lsp:completion',
    async (
      _e,
      payload: { path: string; line: number; character: number }
    ) => {
      if (!appState.currentWorkspace) return { ok: false, items: [] }
      return lspCompletion(
        appState.currentWorkspace,
        payload.path,
        payload.line,
        payload.character
      )
    }
  )

  ipcMain.handle('diagnostics:get', async () => {
    if (!appState.currentWorkspace) return { ok: true, diagnostics: [], detail: 'No workspace' }
    return collectDiagnostics(appState.currentWorkspace)
  })

  ipcMain.handle('language:hover', (_e, filePath: string, word: string) => {
    if (!appState.currentWorkspace) return { ok: true, contents: '' }
    return languageHover(appState.currentWorkspace, filePath, word)
  })

  ipcMain.handle('language:definition', (_e, word: string) => {
    if (!appState.currentWorkspace) return { ok: true, locations: [] }
    return goToDefinition(appState.currentWorkspace, word)
  })

  ipcMain.handle('verify:run', async () => {
    if (!appState.currentWorkspace) return { ok: false, command: '', detail: 'No workspace' }
    return runVerify(appState.currentWorkspace)
  })
}
