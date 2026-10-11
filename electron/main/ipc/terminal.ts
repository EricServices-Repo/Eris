import { ipcMain } from 'electron'
import { runWorkspaceCommand } from '../services/shell-run'
import {
  disposePtySession,
  ensurePtySession,
  onPtyData,
  onPtyExit,
  resizePty,
  writePty
} from '../services/pty-session'
import { appState } from '../app-state'

export function registerTerminalIpc(): void {
  ipcMain.handle('terminal:run', async (e, command: string) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const sender = e.sender
    return runWorkspaceCommand(appState.currentWorkspace, command, {
      onChunk: (chunk, stream) => {
        if (!sender.isDestroyed()) {
          sender.send('terminal:data', { chunk, stream })
        }
      }
    })
  })

  onPtyData((data) => {
    if (appState.mainWindow && !appState.mainWindow.isDestroyed()) {
      appState.mainWindow.webContents.send('pty:data', data)
    }
  })
  onPtyExit((info) => {
    if (appState.mainWindow && !appState.mainWindow.isDestroyed()) {
      appState.mainWindow.webContents.send('pty:exit', info)
    }
  })

  ipcMain.handle(
    'pty:ensure',
    (_e, size?: { cols?: number; rows?: number }) => {
      if (!appState.currentWorkspace) return { ok: false, error: 'No workspace open' }
      return ensurePtySession(appState.currentWorkspace, size?.cols ?? 80, size?.rows ?? 24)
    }
  )
  ipcMain.handle('pty:write', (_e, data: string) => writePty(String(data ?? '')))
  ipcMain.handle(
    'pty:resize',
    (_e, size: { cols: number; rows: number }) =>
      resizePty(Number(size?.cols) || 80, Number(size?.rows) || 24)
  )
  ipcMain.handle('pty:kill', () => {
    disposePtySession()
    return { ok: true }
  })
}
