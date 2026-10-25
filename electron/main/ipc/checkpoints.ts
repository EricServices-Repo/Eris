import { ipcMain } from 'electron'
import { restoreCheckpoint, restoreCheckpointOp } from '../services/checkpoints'
import { appState } from '../app-state'
import { acquireProjectWrite } from '../services/agent/task-scheduler'

export function registerCheckpointsIpc(): void {
  ipcMain.handle('checkpoint:restore', async (_e, checkpointId: string) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const root = appState.currentWorkspace
    const release = await acquireProjectWrite(root)
    try {
      if (appState.currentWorkspace !== root)
        throw new Error('Workspace changed while waiting to undo')
      return restoreCheckpoint(root, checkpointId)
    } finally {
      release()
    }
  })

  ipcMain.handle('checkpoint:restoreOp', async (_e, checkpointId: string, opIndex: number) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    const root = appState.currentWorkspace
    const release = await acquireProjectWrite(root)
    try {
      if (appState.currentWorkspace !== root)
        throw new Error('Workspace changed while waiting to undo')
      return restoreCheckpointOp(root, checkpointId, opIndex)
    } finally {
      release()
    }
  })
}
