import { connectDetectedModelService, getModelSetupOptions } from '../services/model-setup'
import { currentLoadedModel } from '../services/model-runtime'
import { inferenceGovernorStatus } from '../services/inference-governor'
import { ipcMain } from 'electron'
import { createHash } from 'crypto'
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
import {
  ERIS_CLOUD_CONNECTION_ID,
  ERIS_CLOUD_TOKEN_REF,
  isErisCloudConnection,
  isErisCloudModelRef
} from '../../../src/shared/eris-cloud'
import type { IdeApi } from '../../../src/shared/api'
import type { AppSettings, ModelInfo, ModelsStatus } from '../../../src/shared/settings-schema'

type CloudProbe = {
  root: string | null
  account: string | null
  enabled: boolean
  result: Promise<ModelsStatus>
}

const cloudAccount = (token: string | null) =>
  token ? createHash('sha256').update(token).digest('hex') : null

function cloudEnabled(settings: AppSettings): boolean {
  return settings.models.connections.some((conn) => conn.enabled && isErisCloudConnection(conn))
}

function withCloudCatalog(status: ModelsStatus, latest?: ModelsStatus): ModelsStatus {
  const isCloud = (model: ModelInfo) =>
    model.connectionId === ERIS_CLOUD_CONNECTION_ID || isErisCloudModelRef(model.name)
  const models = [...status.models.filter((model) => !isCloud(model)), ...(latest?.models.filter(isCloud) ?? [])]
  const connections = status.connections.filter((conn) => !isErisCloudConnection(conn))
  const cloud = latest?.connections.find(isErisCloudConnection)
  if (cloud) connections.push(cloud)
  const ok = status.builtin.some((model) => model.ready) || models.some((model) => model.ready)
  return {
    ...status, models, connections, ok,
    error: ok ? undefined : status.error ?? 'No models ready. Refresh models or choose an available provider.'
  }
}

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
  ipcMain.handle('models:setupOptions', () => getModelSetupOptions())
  ipcMain.handle('models:connectDetected', (_event, id: string) =>
    connectDetectedModelService(id, appState.currentWorkspace)
  )

  ipcMain.handle('models:admission', (event) => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized admission inspection')
    return inferenceGovernorStatus()
  })
  let latestCloudProbe: CloudProbe | undefined
  ipcMain.handle(
    'models:status',
    async (_e, options?: Parameters<IdeApi['modelsStatus']>[0]) => {
      const root = appState.currentWorkspace
      const settings = getResolvedSettings(root)
      const probe = options?.probe === true
      const probeCloud = probe || options?.probeCloud === true
      const enabled = probeCloud && cloudEnabled(settings)
      const cloudToken = enabled ? getSecret(ERIS_CLOUD_TOKEN_REF) : null
      const includeGpu = options?.includeGpu === true || probe
      const result = getModelsStatus(settings, (key) =>
        probeCloud && key === ERIS_CLOUD_TOKEN_REF ? cloudToken : getSecret(key), {
        probeConnections: probe,
        probeCloud,
        includeGpu
      })
      if (!probeCloud) return result
      const ownProbe: CloudProbe = { root, account: cloudAccount(cloudToken), enabled, result }
      latestCloudProbe = ownProbe
      const status = await result
      const inCurrentScope = () => appState.currentWorkspace === root &&
        cloudEnabled(getResolvedSettings(root)) === enabled &&
        (!enabled || getSecret(ERIS_CLOUD_TOKEN_REF) === cloudToken)
      if (inCurrentScope() && latestCloudProbe === ownProbe) {
        const { connections, changed } = connectionsWithDiscoveredModels(getResolvedSettings(null), status, {
          cloudOnly: !probe
        })
        if (changed) {
          setSettings('user', { models: { connections } }, root)
        }
        return status
      }

      // A caller of the older probe still needs a response. Use the newest Cloud
      // result for this scope, while preserving the caller's other provider data.
      let current = ownProbe
      let cloudStatus = status
      while (inCurrentScope() && current !== latestCloudProbe) {
        const next = latestCloudProbe
        if (!next || next.root !== root || next.account !== ownProbe.account || next.enabled !== enabled)
          return withCloudCatalog(status)
        current = next
        try {
          cloudStatus = await next.result
        } catch {
          return withCloudCatalog(status)
        }
      }
      return withCloudCatalog(status, inCurrentScope() ? cloudStatus : undefined)
    }
  )

  ipcMain.handle('models:warmLocal', async (_event, modelRef?: string) => {
    const settings = getResolvedSettings(appState.currentWorkspace)
    return warmLocalInference(settings, modelRef)
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
    const status = await getGpuAccelStatus(settings.models.preferEgpu !== false)
    const loadedModel = currentLoadedModel()
    return loadedModel ? { ...status, loadedModel } : status
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
