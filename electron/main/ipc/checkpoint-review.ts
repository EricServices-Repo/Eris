import { ipcMain } from 'electron'
import { appState } from '../app-state'
import { checkpointReview, decideCheckpointReview } from '../services/checkpoint-review'
import { acquireProjectWrite } from '../services/agent/task-scheduler'
import type { CheckpointReviewRequest } from '../../../src/shared/checkpoint-review'

export function registerCheckpointReviewIpc(): void {
  ipcMain.handle('checkpoint:review', (_event, id: string) => {
    if (!appState.currentWorkspace) throw new Error('No workspace open')
    return checkpointReview(appState.currentWorkspace, id)
  })
  ipcMain.handle('checkpoint:decide', async (_event, input: CheckpointReviewRequest) => {
    const root = appState.currentWorkspace
    if (!root || !input || typeof input.checkpointId !== 'string')
      throw new Error('Invalid checkpoint review request')
    const release = await acquireProjectWrite(root)
    try {
      if (root !== appState.currentWorkspace) throw new Error('Workspace changed before review')
      return decideCheckpointReview(root, input)
    } finally {
      release()
    }
  })
}
