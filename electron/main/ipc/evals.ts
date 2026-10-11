import { ipcMain } from 'electron'
import { getResolvedSettings } from '../services/settings'
import { appState } from '../app-state'
import { getSecret } from './shared'
import { listEvalTaskInfo } from '../services/eval-tasks'
import { cancelEvalRun, isEvalRunActive, runEvalSuite } from '../services/eval-runner'
import { clearEvalResults, getEvalScoreboard } from '../services/eval-store'

export function registerEvalsIpc(): void {
  ipcMain.handle('evals:list', () => listEvalTaskInfo(appState.currentWorkspace))
  ipcMain.handle('evals:scoreboard', () => getEvalScoreboard())
  ipcMain.handle('evals:clear', () => {
    clearEvalResults()
    return getEvalScoreboard()
  })
  ipcMain.handle('evals:running', () => isEvalRunActive())
  ipcMain.handle('evals:cancel', () => cancelEvalRun())
  ipcMain.handle(
    'evals:run',
    async (
      event,
      payload: { taskIds: string[]; models: string[]; repeats?: number }
    ) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      return runEvalSuite(
        appState.currentWorkspace,
        settings,
        {
          taskIds: payload.taskIds || [],
          models: payload.models || [],
          repeats: payload.repeats ?? 1
        },
        getSecret,
        (evt) => {
          if (!event.sender.isDestroyed()) event.sender.send('evals:progress', evt)
        }
      )
    }
  )
}
