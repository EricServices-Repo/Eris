import { dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'path'
import { getResolvedSettings } from '../services/settings'
import { appState } from '../app-state'
import { getSecret } from './shared'
import { listEvalTaskInfo, listRejectedEvalTasks } from '../services/eval-tasks'
import { cancelEvalRun, isEvalRunActive, runEvalSuite } from '../services/eval-runner'
import { isDebugRunActive } from '../services/debug-runs/coordinator'
import { clearEvalResults, getEvalScoreboard } from '../services/eval-store'
import {
  cancelCorpusDebugRun,
  copyCorpusDebugReport,
  isCorpusDebugRunActive,
  listCorpusDebugRuns,
  runCorpusDebug
} from '../services/corpus-debug-runner'
import type { CorpusDebugRunRequest } from '../../../src/shared/evals'

export function registerEvalsIpc(): void {
  ipcMain.handle('evals:list', () => listEvalTaskInfo(appState.currentWorkspace))
  ipcMain.handle('evals:rejected', () => listRejectedEvalTasks(appState.currentWorkspace))
  ipcMain.handle('evals:scoreboard', () => getEvalScoreboard())
  ipcMain.handle('evals:clear', () => {
    clearEvalResults()
    return getEvalScoreboard()
  })
  ipcMain.handle('evals:running', () => isEvalRunActive())
  ipcMain.handle('evals:cancel', () => cancelEvalRun())
  ipcMain.handle('evals:corpusList', () => listCorpusDebugRuns())
  ipcMain.handle('evals:corpusRunning', () => isCorpusDebugRunActive())
  ipcMain.handle('evals:corpusCancel', () => cancelCorpusDebugRun())
  ipcMain.handle('evals:corpusOpenFolder', () => {
    const latest = listCorpusDebugRuns()[0]
    if (!latest) return false
    shell.showItemInFolder(latest.reviewPath)
    return true
  })
  ipcMain.handle('evals:corpusExport', async (_event, runId: string) => {
    const run = listCorpusDebugRuns().find((item) => item.runId === runId)
    if (!run) throw new Error('Corpus debug report not found')
    const options = {
      title: 'Export real-model corpus review',
      defaultPath: join(appState.currentWorkspace || '', basename(run.reviewPath)),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const picked = appState.mainWindow
      ? await dialog.showSaveDialog(appState.mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    copyCorpusDebugReport(runId, picked.filePath)
    return picked.filePath
  })
  ipcMain.handle('evals:corpusRun', async (event, payload: CorpusDebugRunRequest) => {
    if (isEvalRunActive()) throw new Error('Stop the eval suite before starting a corpus run')
    if (isDebugRunActive()) throw new Error('Stop the diagnostics run before starting a corpus run')
    const settings = getResolvedSettings(appState.currentWorkspace)
    return runCorpusDebug(appState.currentWorkspace, settings, payload, getSecret, (evt) => {
      if (!event.sender.isDestroyed()) event.sender.send('evals:corpusProgress', evt)
    })
  })
  ipcMain.handle(
    'evals:run',
    async (event, payload: { taskIds: string[]; models: string[]; repeats?: number }) => {
      if (isDebugRunActive()) throw new Error('Stop the diagnostics run before starting evals')
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
