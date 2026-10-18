import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ChatDatabase } from '../electron/main/services/chat-database'
import { getDefaults } from '../electron/main/services/settings'
import {
  generateImage,
  imageMediaRoot,
  inspectGeneratedPng,
  readGeneratedImage,
  saveImageToWorkspace
} from '../electron/main/services/image-generation'
import { imagePromptFromCommand, asksForImageGeneration } from '../src/shared/image-generation'
import {
  createCheckpoint,
  recordBinaryCreateOp,
  restoreCheckpoint
} from '../electron/main/services/checkpoints'
import { getToolContract } from '../electron/main/services/tool-registry'
import { toolAllowedByPolicy, classifyIntent } from '../electron/main/services/chat-router'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZLsAAAAASUVORK5CYII=',
  'base64'
)
const workspace = mkdtempSync(join(tmpdir(), 'eris-image-test-'))
const defaults = () => {
  const settings = structuredClone(getDefaults())
  settings.images = {
    backend: 'api',
    enabled: true,
    connectionId: 'images',
    model: 'gpt-image-test',
    quality: 'auto',
    size: '1024x1024'
  }
  settings.models.connections.push({
    id: 'images',
    name: 'Image API',
    type: 'openai-compatible',
    enabled: true,
    provider: 'custom',
    baseUrl: 'https://images.example/v1',
    apiKeyRef: 'images.key',
    models: []
  })
  return settings
}
const request = { requestId: 'test-image', prompt: 'A calm blue illustration' }
function mockResponse(data: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    )
}
afterEach(() => vi.restoreAllMocks())
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('image generation architecture', () => {
  it('generates an image, persists managed bytes/metadata, copies without overwriting, and undoes the binary', async () => {
    const fetch = mockResponse({
      data: [{ b64_json: png.toString('base64'), revised_prompt: 'A blue illustration' }]
    })
    const progress: string[] = []
    const asset = await generateImage({
      request,
      settings: defaults(),
      getSecret: () => 'test-key',
      onProgress: (event) => progress.push(event.stage)
    })
    expect(progress).toEqual(['generating', 'saving', 'complete'])
    const [url, options] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://images.example/v1/images/generations')
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: 'gpt-image-test',
      n: 1,
      output_format: 'png',
      prompt: request.prompt
    })
    expect(asset).toMatchObject({ width: 1, height: 1, kind: 'image', mimeType: 'image/png' })
    expect(await readGeneratedImage(asset.id)).toEqual(png)
    expect(JSON.parse(readFileSync(join(imageMediaRoot(), `${asset.id}.json`), 'utf8')).id).toBe(
      asset.id
    )
    const target = await saveImageToWorkspace(workspace, asset.id, 'assets/illustration.png')
    expect(readFileSync(target)).toEqual(png)
    await expect(
      saveImageToWorkspace(workspace, asset.id, 'assets/illustration.png')
    ).rejects.toThrow()
    const checkpoint = createCheckpoint(workspace)
    recordBinaryCreateOp(workspace, checkpoint.id, 'assets/illustration.png')
    expect(restoreCheckpoint(workspace, checkpoint.id).restored).toBe(1)
    expect(existsSync(target)).toBe(false)
    expect(await readGeneratedImage(asset.id)).toEqual(png)
  })

  it('preserves structured images across chat database reload without embedding their bytes', async () => {
    mockResponse({ data: [{ b64_json: png.toString('base64') }] })
    const asset = await generateImage({ request, settings: defaults(), getSecret: () => 'test' })
    const directory = join(workspace, 'chat-storage')
    let database = new ChatDatabase(directory)
    database.save({
      id: 'image-chat',
      title: 'Image chat',
      model: 'chat-model',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    database.append('image-chat', {
      id: 'image-message',
      role: 'assistant',
      content: 'Generated image',
      assets: [asset],
      createdAt: 2
    })
    database.close()
    database = new ChatDatabase(directory)
    try {
      const message = database.get('image-chat')!.messages[0]!
      expect(message.assets).toEqual([asset])
      expect(JSON.stringify(message)).not.toContain(png.toString('base64'))
    } finally {
      database.close()
    }
  })

  it('rejects disabled generation and missing configuration without calling the provider', async () => {
    const fetch = mockResponse({})
    const settings = defaults()
    settings.images.enabled = false
    await expect(generateImage({ request, settings, getSecret: () => null })).rejects.toThrow(
      'Enable image generation'
    )
    settings.images.enabled = true
    settings.images.connectionId = 'missing'
    await expect(generateImage({ request, settings, getSecret: () => null })).rejects.toThrow(
      'Choose an image provider'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed PNG, truncated data, oversized dimensions, and arbitrary media ids', async () => {
    expect(() => inspectGeneratedPng(Buffer.from('<html>not an image</html>'))).toThrow()
    expect(() => inspectGeneratedPng(png.subarray(0, png.length - 2))).toThrow()
    const huge = Buffer.from(png)
    huge.writeUInt32BE(100_000, 16)
    expect(() => inspectGeneratedPng(huge)).toThrow('dimensions')
    await expect(readGeneratedImage('../../settings')).rejects.toThrow('Invalid image asset id')
  })

  it('rejects traversal and symlink destinations and preserves an existing file', async () => {
    mockResponse({ data: [{ b64_json: png.toString('base64') }] })
    const asset = await generateImage({ request, settings: defaults(), getSecret: () => 'test' })
    await expect(saveImageToWorkspace(workspace, asset.id, '../escape.png')).rejects.toThrow()
    const outside = mkdtempSync(join(tmpdir(), 'eris-images-outside-'))
    symlinkSync(outside, join(workspace, 'external'))
    await expect(saveImageToWorkspace(workspace, asset.id, 'external/escape.png')).rejects.toThrow()
    writeFileSync(join(workspace, 'existing.png'), 'original')
    await expect(saveImageToWorkspace(workspace, asset.id, 'existing.png')).rejects.toThrow()
    expect(readFileSync(join(workspace, 'existing.png'), 'utf8')).toBe('original')
    rmSync(outside, { recursive: true, force: true })
  })

  it('never starts a provider request after cancellation', async () => {
    const fetch = mockResponse({})
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateImage({
        request,
        settings: defaults(),
        getSecret: () => 'test',
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops after cancellation during provider work and does not accept a result', async () => {
    const controller = new AbortController()
    await expect(
      generateImage({
        request,
        settings: defaults(),
        getSecret: () => 'test',
        signal: controller.signal,
        adapter: {
          generate: async () => {
            controller.abort()
            return { bytes: png }
          }
        }
      })
    ).rejects.toThrow()
  })

  it('reports provider failures without leaking response bodies or credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private diagnostic test-key', { status: 401 })
    )
    await expect(
      generateImage({ request, settings: defaults(), getSecret: () => 'test-key' })
    ).rejects.toThrow('HTTP 401')
  })

  it('requires base64 image bytes rather than fetching arbitrary provider URLs', async () => {
    const fetch = mockResponse({ data: [{ url: 'https://untrusted.example/private' }] })
    await expect(
      generateImage({ request, settings: defaults(), getSecret: () => 'test' })
    ).rejects.toThrow('b64_json')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('exposes generation only to editing agents and distinguishes artwork requests from code questions', () => {
    expect(getToolContract('generate_image')).toMatchObject({ access: 'edit', effect: 'workspace' })
    expect(toolAllowedByPolicy('generate_image', 'read')).toBe(false)
    expect(toolAllowedByPolicy('generate_image', 'edit')).toBe(true)
    expect(imagePromptFromCommand('/image a blue mountain')).toBe('a blue mountain')
    expect(imagePromptFromCommand('fix the image component')).toBeNull()
    expect(asksForImageGeneration('Draw a hero illustration')).toBe(true)
    expect(asksForImageGeneration('fix an image loading bug')).toBe(false)
    expect(classifyIntent('Draw a hero illustration', 'agent')).toBe('edit')
    expect(classifyIntent('Draw a hero illustration', 'ask')).toBe('answer')
  })
})
