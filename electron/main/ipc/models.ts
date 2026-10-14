import { ipcMain } from 'electron'
import { getResolvedSettings, setSettings } from '../services/settings'
import { connectionsWithDiscoveredModels, getModelsStatus } from '../services/model-catalog'
import {
  cancelBuiltinDownload,
  deleteBuiltinModel,
  disposeRuntime,
  downloadBuiltinModel,
  getBuiltinStatuses,
  verifyBuiltinModel,
  warmLocalInference
} from '../services/builtin-model'
import {
  applyLlamaGpuPreference,
  getGpuAccelStatus,
  invalidateGpuAccelCache
} from '../services/gpu-accel'
import {
  cancelLocalDownload,
  deleteLocalModel,
  downloadLocalFromHf,
  downloadLocalModel,
  getLocalStatuses
} from '../services/local-model'
import { HF_GGUF_BROWSE_URL, searchHfGgufModels } from '../services/hf-gguf'
import { logError, logInfo, logWarn } from '../services/logger'
import { appState } from '../app-state'
import { getSecret } from './shared'

function flattenError(err: unknown): string {
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
  return [...new Set(parts)].join(' — ') || 'Download failed'
}

export function registerModelsIpc(): void {
  ipcMain.handle(
    'models:status',
    async (_e, options?: { probe?: boolean; includeGpu?: boolean }) => {
      const settings = getResolvedSettings(appState.currentWorkspace)
      const probe = options?.probe === true
      const includeGpu = options?.includeGpu === true || probe
      const status = await getModelsStatus(settings, getSecret, {
        probeConnections: probe,
        includeGpu
      })
      // Persist live /v1/models lists only when we actually probed.
      if (probe) {
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
      }
      return status
    }
  )

  ipcMain.handle('models:warmLocal', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    return warmLocalInference(settings)
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
      const message = flattenError(err)
      logError('Builtin model download failed', { id: modelId, error: message })
      throw new Error(message)
    }
  })

  ipcMain.handle('models:cancelDownload', () => {
    cancelBuiltinDownload()
    cancelLocalDownload()
    logWarn('Model download cancelled')
    return true
  })

  ipcMain.handle('models:deleteBuiltin', (_e, id: string) => {
    return deleteBuiltinModel(id || 'composer-lite')
  })

  ipcMain.handle('models:verifyBuiltin', async (_e, id: string) => {
    return verifyBuiltinModel(id || 'composer-lite')
  })

  ipcMain.handle('models:localStatus', () => getLocalStatuses())

  ipcMain.handle('models:downloadLocal', async (event, id: string) => {
    const modelId = String(id || '').trim()
    if (!modelId) throw new Error('Model id is required')
    logInfo('Local model download start', { id: modelId })
    try {
      const status = await downloadLocalModel(modelId, (progress) => {
        event.sender.send('models:localDownloadProgress', progress)
      })
      logInfo('Local model download complete', { id: modelId, ready: status.ready })
      return status
    } catch (err) {
      const message = flattenError(err)
      logError('Local model download failed', { id: modelId, error: message })
      throw new Error(message)
    }
  })

  ipcMain.handle('models:deleteLocal', (_e, id: string) => {
    return deleteLocalModel(String(id || '').trim())
  })

  ipcMain.handle('models:cancelLocalDownload', () => {
    cancelLocalDownload()
    logWarn('Local model download cancelled')
    return true
  })

  ipcMain.handle('models:hfBrowseUrl', () => HF_GGUF_BROWSE_URL)

  ipcMain.handle('models:searchHfGguf', async (_e, query: string) => {
    const q = String(query || '').trim()
    if (!q) return []
    try {
      return await searchHfGgufModels(q, { limit: 24 })
    } catch (err) {
      const message = flattenError(err)
      logError('Hugging Face GGUF search failed', { query: q, error: message })
      throw new Error(message)
    }
  })

  ipcMain.handle('models:downloadLocalFromHf', async (event, repoIdOrUrl: string) => {
    const ref = String(repoIdOrUrl || '').trim()
    if (!ref) throw new Error('Hugging Face model id or URL is required')
    logInfo('Local model download from Hugging Face start', { ref })
    try {
      const status = await downloadLocalFromHf(ref, (progress) => {
        event.sender.send('models:localDownloadProgress', progress)
      })
      logInfo('Local model download from Hugging Face complete', {
        id: status.id,
        ready: status.ready
      })
      return status
    } catch (err) {
      const message = flattenError(err)
      logError('Local model download from Hugging Face failed', { ref, error: message })
      throw new Error(message)
    }
  })

  ipcMain.handle('models:gpuStatus', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    return getGpuAccelStatus(settings.models.preferEgpu !== false)
  })

  ipcMain.handle('models:reloadLlamaGpu', async () => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    const prefer = settings.models.preferEgpu !== false
    invalidateGpuAccelCache()
    await disposeRuntime()
    const { status } = await applyLlamaGpuPreference(prefer)
    logInfo('Reloaded llama GPU preference', {
      preferEgpu: prefer,
      preferred: status.preferredGpu?.name || null,
      tier: status.accelTier,
      egpu: status.egpu?.name || null,
      usable: status.accelUsable,
      backend: status.backend,
      devices: status.devices.map((d) => `${d.kind}:${d.name}`)
    })
    return status
  })
}
