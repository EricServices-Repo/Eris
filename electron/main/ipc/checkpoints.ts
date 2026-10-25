import { ipcMain } from 'electron'
import { restoreCheckpoint, restoreCheckpointOp } from '../services/checkpoints'
import { appState } from '../app-state'

export function registerCheckpointsIpc(): void {
  ipcMain.handle('checkpoint:restore', (_e, checkpointId: string) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    return restoreCheckpoint(appState.currentWorkspace, checkpointId)
  })

  ipcMain.handle(
    'checkpoint:restoreOp',
    (_e, checkpointId: string, opIndex: number) => {
      if (!appState.currentWorkspace) throw new Error('No workspace open')
      return restoreCheckpointOp(appState.currentWorkspace, checkpointId, opIndex)
    }
  )
}
