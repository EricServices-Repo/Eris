import { writeFileSync } from 'fs'
import { dialog, ipcMain, type WebContents } from 'electron'
import { DebugExportRequestSchema } from '../../../src/shared/debug-runs'
import { appState } from '../app-state'
import {
  cancelDebugRun,
  getDebugRun,
  isDebugRunActive,
  listDebugRuns,
  replayDebugRun,
  startDebugRun,
  type DebugRunDeps
} from '../services/debug-runs/coordinator'
import {
  buildDebugRunExport,
  previewDebugRunExport,
  renderDebugRunMarkdown
} from '../services/debug-runs/export'
import { listDebugScenarioInfo } from '../services/debug-runs/scenarios'
import { assertRunId, deleteAllDebugRuns, deleteDebugRun } from '../services/debug-runs/store'
import { isCorpusDebugRunActive } from '../services/corpus-debug-runner'
import { isEvalRunActive } from '../services/eval-runner'
import { getResolvedSettings } from '../services/settings'
import { getSecret } from './shared'

function assertIdle(): void {
  if (isEvalRunActive()) throw new Error('Stop the eval suite before starting a diagnostics run')
  if (isCorpusDebugRunActive())
    throw new Error('Stop the corpus run before starting a diagnostics run')
}

function deps(sender: WebContents): DebugRunDeps {
  return {
    // User-level settings only: diagnostics never read the selected workspace.
    settings: getResolvedSettings(null),
    getSecret,
    onProgress: (event) => {
      if (!sender.isDestroyed()) sender.send('debugRuns:event', event)
    }
  }
}

function requireRun(runId: unknown) {
  const detail = getDebugRun(assertRunId(String(runId)))
  if (!detail) throw new Error('Diagnostics run not found')
  return detail
}

export function registerDebugRunsIpc(): void {
  ipcMain.handle('debugRuns:scenarios', () => listDebugScenarioInfo())
  ipcMain.handle('debugRuns:list', () => listDebugRuns())
  ipcMain.handle('debugRuns:get', (_event, runId: unknown) => requireRun(runId))
  ipcMain.handle('debugRuns:running', () => isDebugRunActive())
  ipcMain.handle('debugRuns:cancel', () => cancelDebugRun())
  ipcMain.handle('debugRuns:start', (event, payload: unknown) => {
    assertIdle()
    return startDebugRun(payload, deps(event.sender))
  })
  ipcMain.handle('debugRuns:replay', (event, payload: unknown) => {
    assertIdle()
    return replayDebugRun(payload, deps(event.sender))
  })
  ipcMain.handle('debugRuns:exportPreview', (_event, payload: unknown) => {
    const request = DebugExportRequestSchema.parse(payload)
    return previewDebugRunExport(requireRun(request.runId), request.includeResponses)
  })
  ipcMain.handle('debugRuns:export', async (_event, payload: unknown) => {
    const request = DebugExportRequestSchema.parse(payload)
    const detail = requireRun(request.runId)
    const options = {
      title: 'Export diagnostics run',
      defaultPath: `eris-diagnostics-${detail.summary.runId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const picked = appState.mainWindow
      ? await dialog.showSaveDialog(appState.mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    const jsonPath = picked.filePath.endsWith('.json') ? picked.filePath : `${picked.filePath}.json`
    const markdownPath = jsonPath.replace(/\.json$/, '.md')
    const bundle = buildDebugRunExport(detail, request.includeResponses)
    writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), 'utf8')
    writeFileSync(
      markdownPath,
      renderDebugRunMarkdown({ ...detail, summary: bundle.summary, cases: bundle.cases }),
      'utf8'
    )
    return { jsonPath, markdownPath }
  })
  ipcMain.handle('debugRuns:delete', (_event, runId: unknown) => {
    const id = assertRunId(String(runId))
    if (getDebugRun(id)?.summary.status === 'running')
      throw new Error('Stop the run before deleting it')
    return deleteDebugRun(id)
  })
  ipcMain.handle('debugRuns:deleteAll', () => deleteAllDebugRuns())
}
