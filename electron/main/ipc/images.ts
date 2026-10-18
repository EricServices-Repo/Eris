import {
  setupLocalImageRuntime,
  downloadLocalImageModel,
  deleteLocalImageModel,
  localImageStatus
} from '../services/local-image-model'
import type { LocalImageProgress, LocalImageStatus } from '../../../src/shared/image-generation'
import { ipcMain, protocol } from 'electron'
import { ImageGenerationRequestSchema } from '../../../src/shared/image-generation-schema'
import type { ImageGenerationResult } from '../../../src/shared/image-generation'
import { appState } from '../app-state'
import { getResolvedSettings } from '../services/settings'
import {
  generateImage,
  readGeneratedImage,
  saveImageToWorkspace
} from '../services/image-generation'
import { getSecret } from './shared'

export function registerImageIpc(): void {
  const localOperations = new Map<number, AbortController>()
  const localOperation = async (
    event: Electron.IpcMainInvokeEvent,
    action: (
      signal: AbortSignal,
      emit: (progress: LocalImageProgress) => void
    ) => Promise<LocalImageStatus>
  ) => {
    if (localOperations.has(event.sender.id))
      return { ok: false, error: 'A local image operation is already running' }
    const controller = new AbortController()
    localOperations.set(event.sender.id, controller)
    const onDestroyed = () => controller.abort()
    event.sender.once('destroyed', onDestroyed)
    try {
      const status = await action(controller.signal, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('images:localProgress', progress)
      })
      return { ok: true, status }
    } catch (error) {
      return {
        ok: false,
        error: controller.signal.aborted
          ? 'Local image operation stopped'
          : error instanceof Error
            ? error.message
            : 'Local image operation failed'
      }
    } finally {
      localOperations.delete(event.sender.id)
      event.sender.removeListener('destroyed', onDestroyed)
    }
  }
  ipcMain.handle('images:localStatus', () => localImageStatus())
  ipcMain.handle('images:setupLocal', (event) =>
    localOperation(event, (signal, emit) => setupLocalImageRuntime(signal, emit))
  )
  ipcMain.handle('images:downloadLocal', (event, repoId: string) =>
    localOperation(event, (signal, onProgress) =>
      downloadLocalImageModel(repoId, {
        signal,
        onProgress,
        token: getSecret('huggingface.imageToken')
      })
    )
  )
  ipcMain.handle('images:deleteLocal', (event, id: string) =>
    localOperation(event, () => deleteLocalImageModel(id))
  )
  ipcMain.handle('images:cancelLocalOperation', (event) => {
    const controller = localOperations.get(event.sender.id)
    controller?.abort()
    return Boolean(controller)
  })
  const active = new Map<number, { id: string; controller: AbortController }>()
  ipcMain.handle('images:generate', async (event, raw): Promise<ImageGenerationResult> => {
    const parsed = ImageGenerationRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: 'A prompt and request id are required' }
    if (active.has(event.sender.id)) return { ok: false, error: 'An image is already generating' }
    const request = parsed.data
    const controller = new AbortController()
    active.set(event.sender.id, { id: request.requestId, controller })
    const onDestroyed = () => controller.abort()
    event.sender.once('destroyed', onDestroyed)
    try {
      const asset = await generateImage({
        request,
        settings: getResolvedSettings(appState.currentWorkspace),
        getSecret,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('images:progress', progress)
        }
      })
      return { ok: true, asset }
    } catch (error) {
      return {
        ok: false,
        aborted: controller.signal.aborted,
        error: controller.signal.aborted
          ? 'Image generation stopped'
          : error instanceof Error
            ? error.message
            : 'Image generation failed'
      }
    } finally {
      active.delete(event.sender.id)
      event.sender.removeListener('destroyed', onDestroyed)
    }
  })
  ipcMain.handle('images:cancel', (event, requestId: string) => {
    const request = active.get(event.sender.id)
    if (!request || request.id !== requestId) return false
    request.controller.abort()
    return true
  })
  ipcMain.handle('images:saveToWorkspace', async (_event, id: string, path: string) => {
    try {
      const workspace = appState.currentWorkspace
      if (!workspace) throw new Error('Open a workspace before saving an image')
      await saveImageToWorkspace(workspace, id, path)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not save image' }
    }
  })
}

/** IDs resolve only into managed media; the renderer cannot request arbitrary files. */
export function registerImageProtocol(): void {
  protocol.handle('eris-media', async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.hostname !== 'image' || url.search || url.hash) {
        return new Response('Invalid media request', { status: 400 })
      }
      const bytes = await readGeneratedImage(url.pathname.slice(1))
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Image unavailable', { status: 404 })
    }
  })
}
