import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeneratedImageAsset } from '../src/shared/image-generation'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  protocols: new Map<string, (request: Request) => Promise<Response>>(),
  generate: vi.fn()
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler)
  },
  protocol: {
    handle: (name: string, handler: (request: Request) => Promise<Response>) =>
      state.protocols.set(name, handler)
  }
}))
vi.mock('../electron/main/services/image-generation', async (original) => ({
  ...(await original<typeof import('../electron/main/services/image-generation')>()),
  generateImage: (options: unknown) => state.generate(options)
}))
import { registerImageIpc, registerImageProtocol } from '../electron/main/ipc/images'

const asset: GeneratedImageAsset = {
  id: '5ae089b5-3cab-4c66-a8e4-cf60da88a5f5',
  kind: 'image',
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
  bytes: 100,
  provider: 'Test',
  model: 'test-image',
  prompt: 'A mountain',
  createdAt: 1
}
function event(id: number) {
  return {
    sender: Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: vi.fn() })
  }
}
beforeEach(() => {
  state.handlers.clear()
  state.protocols.clear()
  state.generate.mockReset()
  registerImageIpc()
  registerImageProtocol()
})

describe('image generation IPC', () => {
  it('validates the request and returns a structured result with progress', async () => {
    const sender = event(1)
    const handler = state.handlers.get('images:generate')!
    expect(await handler(sender, { prompt: '', requestId: 'bad' })).toMatchObject({ ok: false })
    expect(state.generate).not.toHaveBeenCalled()
    state.generate.mockImplementation(async (options) => {
      options.onProgress({ requestId: 'image-1', stage: 'saving' })
      return asset
    })
    expect(await handler(sender, { prompt: 'A mountain', requestId: 'image-1' })).toEqual({
      ok: true,
      asset
    })
    expect(sender.sender.send).toHaveBeenCalledWith('images:progress', {
      requestId: 'image-1',
      stage: 'saving'
    })
    expect(sender.sender.listenerCount('destroyed')).toBe(0)
  })

  it('rejects overlapping requests and cancels only a request owned by that renderer', async () => {
    const sender = event(2)
    state.generate.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const handler = state.handlers.get('images:generate')!
    const pending = handler(sender, { prompt: 'A mountain', requestId: 'image-2' })
    expect(
      await handler(sender, { prompt: 'Another mountain', requestId: 'image-3' })
    ).toMatchObject({ ok: false })
    const cancel = state.handlers.get('images:cancel')!
    expect(cancel(event(99), 'image-2')).toBe(false)
    expect(cancel(sender, 'wrong-id')).toBe(false)
    expect(cancel(sender, 'image-2')).toBe(true)
    expect(await pending).toMatchObject({ ok: false, aborted: true })
    state.generate.mockResolvedValue(asset)
    expect(await handler(sender, { prompt: 'Try again', requestId: 'image-4' })).toMatchObject({
      ok: true
    })
  })

  it('aborts when the requesting renderer closes', async () => {
    const sender = event(3)
    state.generate.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const pending = state.handlers.get('images:generate')!(sender, {
      prompt: 'A mountain',
      requestId: 'image-5'
    })
    sender.sender.emit('destroyed')
    expect(await pending).toMatchObject({ ok: false, aborted: true })
    expect(sender.sender.listenerCount('destroyed')).toBe(0)
  })

  it('rejects arbitrary paths, non-image hosts, and non-GET media requests', async () => {
    const handler = state.protocols.get('eris-media')!
    expect((await handler(new Request('eris-media://image/settings.json'))).status).toBe(404)
    expect((await handler(new Request('eris-media://image/%2e%2e%2fsettings.json'))).status).toBe(
      404
    )
    expect((await handler(new Request('eris-media://files/anything'))).status).toBe(400)
    expect(
      (await handler(new Request(`eris-media://image/${asset.id}`, { method: 'POST' }))).status
    ).toBe(400)
  })
})
