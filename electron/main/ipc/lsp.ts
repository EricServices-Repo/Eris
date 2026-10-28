import { z } from 'zod'
import { previewLanguageEdit, applyLanguageEdit } from '../services/language-edits'
import { negotiatedLanguageCapabilities } from '../services/language-servers'
import { isWorkspaceTrusted } from '../services/workspace-trust'
import { resolveInWorkspace, realpathAllowMissing } from '../services/workspace-fs'
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
  onExtraLspDiagnostics,
  onLspDiagnostics
} from '../services/language-servers'
import { appState } from '../app-state'

export function registerLspIpc(): void {
  const owner = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized window/frame')
    const root = appState.currentWorkspace
    if (!root || !isWorkspaceTrusted(root))
      throw new Error('Trust the workspace before using language edit processes')
    return {
      root,
      current: () =>
        !!appState.currentWorkspace &&
        realpathAllowMissing(appState.currentWorkspace) === realpathAllowMissing(root) &&
        isWorkspaceTrusted(root) &&
        event.sender === appState.mainWindow?.webContents
    }
  }
  ipcMain.handle('lsp:capabilities', async (event, raw: unknown) => {
    const { root } = owner(event),
      path = z.string().min(1).max(4096).parse(raw)
    return negotiatedLanguageCapabilities(root, resolveInWorkspace(root, path))
  })
  ipcMain.handle('lsp:previewEdit', async (event, raw: unknown) => {
    const { root, current } = owner(event)
    if (Buffer.byteLength(JSON.stringify(raw)) > 2200000)
      throw new Error('Language edit request too large')
    const input = z
      .object({
        path: z.string().min(1).max(4096),
        text: z.string().max(2000000),
        kind: z.enum(['formatting', 'rename', 'codeActions']),
        params: z.record(z.string(), z.unknown())
      })
      .strict()
      .parse(raw)
    return previewLanguageEdit(root, input, event.sender.id, current)
  })
  ipcMain.handle('lsp:applyEdit', async (event, raw: unknown) => {
    const { root, current } = owner(event)
    return applyLanguageEdit(root, z.string().uuid().parse(raw), event.sender.id, current)
  })
  const sendDiags = (items: { path: string }[]) => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed() || !items.length) return
    const path = items[0]!.path
    appState.mainWindow.webContents.send('lsp:diagnostics', { path, diagnostics: items })
  }
  onLspDiagnostics(sendDiags)
  onExtraLspDiagnostics(sendDiags)

  ipcMain.handle(
    'lsp:didOpen',
    async (_e, payload: { path: string; language: string; text: string }) => {
      if (!appState.currentWorkspace) return { ok: false }
      await lspDidOpen(appState.currentWorkspace, payload.path, payload.language, payload.text)
      return { ok: true }
    }
  )
  ipcMain.handle(
    'lsp:didChange',
    async (_e, payload: { path: string; language: string; text: string }) => {
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
    async (_e, payload: { path: string; line: number; character: number }) => {
      if (!appState.currentWorkspace) return { ok: false, contents: '' }
      return lspHover(appState.currentWorkspace, payload.path, payload.line, payload.character)
    }
  )
  ipcMain.handle(
    'lsp:definition',
    async (_e, payload: { path: string; line: number; character: number }) => {
      if (!appState.currentWorkspace) return { ok: false, locations: [] }
      return lspDefinition(appState.currentWorkspace, payload.path, payload.line, payload.character)
    }
  )
  ipcMain.handle(
    'lsp:completion',
    async (_e, payload: { path: string; line: number; character: number }) => {
      if (!appState.currentWorkspace) return { ok: false, items: [] }
      return lspCompletion(appState.currentWorkspace, payload.path, payload.line, payload.character)
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
