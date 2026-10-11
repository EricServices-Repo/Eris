import { ipcMain } from 'electron'
import { appState } from '../app-state'
import { getSecret } from './shared'
import {
  backgroundJobDiff,
  configureBackgroundAgents,
  discardBackgroundJob,
  enqueueBackgroundJob,
  listBackgroundJobs,
  mergeBackgroundJob,
  onBackgroundJobEvent,
  stopBackgroundJob
} from '../services/background-agents'

export function registerBackgroundAgentsIpc(): void {
  onBackgroundJobEvent((event) => {
    const win = appState.mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send('agents:job', event)
  })

  ipcMain.handle('agents:jobs', () => listBackgroundJobs(appState.currentWorkspace))
  ipcMain.handle(
    'agents:enqueue',
    (event, payload: { goal: string; model: string; agentId?: string }) => {
      if (!appState.currentWorkspace) throw new Error('Open a workspace first')
      configureBackgroundAgents({ sender: event.sender, getSecret })
      return enqueueBackgroundJob({
        workspacePath: appState.currentWorkspace,
        goal: String(payload.goal || ''),
        model: String(payload.model || ''),
        agentId: payload.agentId
      })
    }
  )
  ipcMain.handle('agents:stopJob', (_e, id: string) => stopBackgroundJob(String(id)))
  ipcMain.handle('agents:discardJob', (_e, id: string) => discardBackgroundJob(String(id)))
  ipcMain.handle('agents:mergeJob', (_e, id: string) => mergeBackgroundJob(String(id)))
  ipcMain.handle('agents:jobDiff', (_e, id: string) => backgroundJobDiff(String(id)))
}
