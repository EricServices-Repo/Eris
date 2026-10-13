import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { connectionsWithDiscoveredModels, getModelsStatus } from '../services/model-catalog'
import {
  cancelBuiltinDownload,
  deleteBuiltinModel,
  downloadBuiltinModel,
  getBuiltinStatuses,
  verifyBuiltinModel
} from '../services/builtin-model'
import { logError, logInfo, logWarn } from '../services/logger'
import { appState } from '../app-state'
import { getSecret } from './shared'

export function registerModelsIpc(): void {
  ipcMain.handle('models:status', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const status = await getModelsStatus(settings, getSecret)
    // Keep connection.models in sync with live Ollama/API lists so chat can route by model id.
    const { connections, changed } = connectionsWithDiscoveredModels(settings, status)
    if (changed) {
      setSettings('user', { models: { connections } }, appState.currentWorkspace)
      return {
        ...status,
        connections: status.connections.map((c) => {
          const updated = connections.find((u) => u.id === c.id)
          return updated ? { ...c, models: updated.models } : c
        })
      }
    }
    return status
  })

  ipcMain.handle('models:builtinStatus', () => getBuiltinStatuses())

  ipcMain.handle('models:downloadBuiltin', async (event, id: string) => {
    const modelId = id || 'composer-lite'
    logInfo('Builtin model download start', { id: modelId })
    try {
      const status = await downloadBuiltinModel(modelId, (progress) => {
        event.sender.send('models:downloadProgress', progress)
      })
      logInfo('Builtin model download complete', { id: modelId, ready: status.ready })
      return status
    } catch (err) {
      // Flatten cause chain — Electron IPC often drops Error.cause on the renderer.
      const parts: string[] = []
      let cur: unknown = err
      for (let i = 0; i < 5 && cur; i++) {
        if (cur instanceof Error) {
          if (cur.message) parts.push(cur.message)
          cur = (cur as Error & { cause?: unknown }).cause
        } else {
          parts.push(String(cur))
          break
        }
      }
      const message = [...new Set(parts)].join(' — ') || 'Download failed'
      logError('Builtin model download failed', { id: modelId, error: message })
      throw new Error(message)
    }
  })

  ipcMain.handle('models:cancelDownload', () => {
    cancelBuiltinDownload()
    logWarn('Builtin model download cancelled')
    return true
  })

  ipcMain.handle('models:deleteBuiltin', (_e, id: string) => {
    return deleteBuiltinModel(id || 'composer-lite')
  })

  ipcMain.handle('models:verifyBuiltin', async (_e, id: string) => {
    return verifyBuiltinModel(id || 'composer-lite')
  })
}
