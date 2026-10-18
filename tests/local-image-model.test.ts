import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: object) =>
      command.replaceAll('\\', '/').endsWith('bin/python') ||
      command.replaceAll('\\', '/').endsWith('Scripts/python.exe')
        ? actual.spawn(
            process.execPath,
            [join(process.cwd(), 'tests/fixtures/local-image-worker.cjs')],
            options
          )
        : actual.spawn(command, args, options)
  }
})
import {
  downloadLocalImageModel,
  localImageStatus,
  localImagePython,
  localImageRoot,
  localImageRuntimeRoot,
  normalizeImageRepo,
  deleteLocalImageModel,
  runImageProcess
} from '../electron/main/services/local-image-model'
import { generateImage } from '../electron/main/services/image-generation'
import { getDefaults } from '../electron/main/services/settings'
import { listLocalCatalog } from '../electron/main/services/local-model'

beforeEach(() => {
  mkdirSync(dirname(localImagePython()), { recursive: true })
  writeFileSync(localImagePython(), 'test runtime executable')
})
afterEach(() => {
  rmSync(localImageRoot(), { recursive: true, force: true })
  rmSync(localImageRuntimeRoot(), { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('local Hugging Face image models', () => {
  it('downloads through the process protocol, selects automatically, generates through the image service, and stays out of chat models', async () => {
    const status = await downloadLocalImageModel('https://huggingface.co/stabilityai/sd-turbo')
    expect(status.runtime.ready).toBe(true)
    expect(status.models).toHaveLength(1)
    expect(status.activeModelId).toBe(status.models[0]!.id)
    expect(listLocalCatalog().some((model) => model.ref.includes('sd-turbo'))).toBe(false)
    const settings = structuredClone(getDefaults())
    settings.images.backend = 'local'
    settings.images.enabled = true
    settings.images.connectionId = ''
    settings.images.model = ''
    const fetch = vi.spyOn(globalThis, 'fetch')
    const secret = vi.fn(() => null)
    const asset = await generateImage({
      request: { requestId: 'local-smoke', prompt: 'A mountain illustration' },
      settings,
      getSecret: secret
    })
    expect(asset).toMatchObject({
      provider: 'Local Diffusers',
      model: 'stabilityai/sd-turbo',
      mimeType: 'image/png',
      width: 1,
      height: 1
    })
    expect(secret).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(
      readdirSync(localImageRuntimeRoot()).some((name) => name.startsWith('generation-'))
    ).toBe(false)
    await deleteLocalImageModel(status.activeModelId!)
    expect((await localImageStatus()).activeModelId).toBeNull()
  })

  it('chooses the latest complete download and ignores incomplete files', async () => {
    await downloadLocalImageModel('stabilityai/sd-turbo')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const status = await downloadLocalImageModel('stabilityai/sdxl-turbo')
    expect(status.models.find((model) => model.id === status.activeModelId)?.repoId).toBe(
      'stabilityai/sdxl-turbo'
    )
    const active = status.activeModelId!
    rmSync(join(localImageRoot(), active, 'model_index.json'))
    const next = await localImageStatus()
    expect(next.models.find((model) => model.id === next.activeModelId)?.repoId).toBe(
      'stabilityai/sd-turbo'
    )
  })

  it('cancels a download, releases the operation lock, and never marks the partial model ready', async () => {
    const controller = new AbortController()
    const progress: string[] = []
    const download = downloadLocalImageModel('slow/model', {
      signal: controller.signal,
      onProgress: (event) => {
        progress.push(event.message)
        if (event.operation === 'download') controller.abort()
      }
    })
    await expect(download).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress.length).toBeGreaterThan(0)
    expect((await localImageStatus()).models).toHaveLength(0)
    expect((await downloadLocalImageModel('stabilityai/sd-turbo')).models).toHaveLength(1)
  })

  it('surfaces local inference failures without calling a cloud provider and cleans temporary output', async () => {
    await downloadLocalImageModel('stabilityai/sd-turbo')
    const settings = structuredClone(getDefaults())
    settings.images.enabled = true
    settings.images.backend = 'local'
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(
      generateImage({
        request: { requestId: 'fail-local', prompt: 'FAIL' },
        settings,
        getSecret: () => null
      })
    ).rejects.toThrow('Simulated local inference failure')
    expect(fetch).not.toHaveBeenCalled()
    expect(
      readdirSync(localImageRuntimeRoot()).some((name) => name.startsWith('generation-'))
    ).toBe(false)
  })

  it('rejects arbitrary model paths, commands, and non-Hugging Face URLs', () => {
    expect(normalizeImageRepo('stabilityai/sd-turbo')).toBe('stabilityai/sd-turbo')
    for (const invalid of [
      '../model',
      'owner/..',
      'https://evil.example/model',
      'owner/model; touch x',
      '/tmp/model'
    ]) {
      expect(() => normalizeImageRepo(invalid)).toThrow()
    }
  })

  it('terminates a stuck subprocess on timeout', async () => {
    await expect(
      runImageProcess({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        timeoutMs: 50
      })
    ).rejects.toThrow('timed out')
  })
})
