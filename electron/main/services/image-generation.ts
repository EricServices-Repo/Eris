import { generateLocalImage } from './local-image-model'
import { ImageGenerationRequestSchema } from '../../../src/shared/image-generation-schema'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { mkdir, readFile, writeFile, rename, rm, copyFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type { AppSettings, ModelConnection } from '../../../src/shared/settings-schema'
import type {
  GeneratedImageAsset,
  ImageGenerationProgress,
  ImageGenerationRequest
} from '../../../src/shared/image-generation'
import { userDataRoot } from './paths'
import { isPathInside, resolveInWorkspace } from './workspace-fs'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

export interface ImageProviderAdapter {
  generate(options: {
    connection: ModelConnection
    apiKey: string | null
    model: string
    prompt: string
    size: string
    quality: string
    signal: AbortSignal
  }): Promise<{ bytes: Buffer; revisedPrompt?: string }>
}

/** Bounded body reads protect both the renderer and main process from oversized responses. */
async function readResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('Image provider returned an empty response')
  const reader = response.body.getReader()
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new Error('Image provider response exceeds 30 MB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Adapter for the Images API; local servers can implement the same API. */
export const openAIImagesAdapter: ImageProviderAdapter = {
  async generate({ connection, apiKey, model, prompt, size, quality, signal }) {
    const url = new URL(
      `${connection.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/images/generations`
    )
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Image provider must have an HTTP(S) base URL without embedded credentials')
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Remote image providers require HTTPS; HTTP is allowed for localhost only')
    }
    const isGptImage = /^gpt-image-/i.test(model)
    const body = {
      model,
      prompt,
      n: 1,
      size,
      ...(isGptImage ? { output_format: 'png', quality } : { response_format: 'b64_json' })
    }
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Image provider returned HTTP ${response.status}. Check its model, credentials, and image API support.`
      )
    }
    const result = z
      .object({
        data: z
          .array(
            z.object({
              b64_json: z
                .string()
                .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
                .optional(),
              revised_prompt: z.string().max(16_000).optional()
            })
          )
          .min(1)
          .max(4)
      })
      .parse(JSON.parse(await readResponse(response)))
    const image = result.data?.[0]
    if (!image?.b64_json || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) {
      throw new Error(
        'Image provider must return PNG bytes in data[0].b64_json. URL-only responses are unsupported.'
      )
    }
    if (image.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error('Generated image exceeds 20 MB')
    }
    return { bytes: Buffer.from(image.b64_json, 'base64'), revisedPrompt: image.revised_prompt }
  }
}

/** Validate the PNG container and dimensions before accepting provider bytes. */
export function inspectGeneratedPng(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 45 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error('Image provider returned invalid PNG data or an image larger than 20 MB')
  }
  let offset = 8
  let hasData = false
  let ended = false
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG is missing its image header')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height || width > 4096 || height > 4096)
    throw new Error('Unsupported image dimensions')
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (offset + 12 + length > bytes.length) throw new Error('Truncated PNG data')
    if (type === 'IDAT') hasData = true
    offset += 12 + length
    if (type === 'IEND') {
      ended = length === 0 && offset === bytes.length
      break
    }
  }
  if (!hasData || !ended) throw new Error('Incomplete PNG data')
  return { width, height }
}

export function imageMediaRoot(): string {
  return join(userDataRoot(), 'media', 'images')
}
function imagePath(id: string, suffix: string): string {
  if (!UUID.test(id)) throw new Error('Invalid image asset id')
  const path = join(imageMediaRoot(), `${id}.${suffix}`)
  if (!isPathInside(imageMediaRoot(), path)) throw new Error('Image path escapes managed storage')
  return path
}

export async function readGeneratedImage(id: string): Promise<Buffer> {
  const path = imagePath(id, 'png')
  if ((await stat(path)).size > MAX_IMAGE_BYTES) throw new Error('Image exceeds storage limit')
  const bytes = await readFile(path)
  inspectGeneratedPng(bytes)
  return bytes
}

export async function generateImage(options: {
  request: ImageGenerationRequest
  settings: AppSettings
  getSecret: (ref: string) => string | null
  signal?: AbortSignal
  onProgress?: (progress: ImageGenerationProgress) => void
  adapter?: ImageProviderAdapter
}): Promise<GeneratedImageAsset> {
  const request = ImageGenerationRequestSchema.parse(options.request)
  const config = options.settings.images
  if (!config.enabled)
    throw new Error('Enable image generation in Settings → Providers → Image generation')
  const local = config.backend === 'local'
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(local ? 900_000 : 180_000)])
    : AbortSignal.timeout(local ? 900_000 : 180_000)
  signal.throwIfAborted()
  options.onProgress?.({ requestId: request.requestId, stage: 'generating' })
  let generated: { bytes: Buffer; revisedPrompt?: string }
  let provider: string
  let model: string
  if (local) {
    const result = await generateLocalImage({
      prompt: request.prompt,
      size: request.size ?? config.size,
      signal,
      onProgress: (detail) =>
        options.onProgress?.({ requestId: request.requestId, stage: 'generating', detail })
    })
    generated = result
    provider = 'Local Diffusers'
    model = result.model
  } else {
    const connection = options.settings.models.connections.find(
      (item) => item.id === config.connectionId && item.enabled && item.type === 'openai-compatible'
    )
    if (!connection || !config.model.trim())
      throw new Error('Choose an image provider and model in Settings → Providers')
    const apiKey = connection.apiKeyRef ? options.getSecret(connection.apiKeyRef) : null
    if (connection.apiKeyRef && !apiKey) throw new Error('Image provider API key is missing')
    generated = await (options.adapter ?? openAIImagesAdapter).generate({
      connection,
      apiKey,
      model: config.model.trim(),
      prompt: request.prompt,
      size: request.size ?? config.size,
      quality: config.quality,
      signal
    })
    provider = connection.name
    model = config.model.trim()
  }
  signal.throwIfAborted()
  const dimensions = inspectGeneratedPng(generated.bytes)
  const asset: GeneratedImageAsset = {
    id: randomUUID(),
    kind: 'image',
    mimeType: 'image/png',
    ...dimensions,
    bytes: generated.bytes.length,
    provider,
    model,
    prompt: request.prompt,
    revisedPrompt: generated.revisedPrompt,
    createdAt: Date.now()
  }
  options.onProgress?.({ requestId: request.requestId, stage: 'saving' })
  await mkdir(imageMediaRoot(), { recursive: true })
  const path = imagePath(asset.id, 'png')
  const temporary = imagePath(asset.id, 'tmp')
  try {
    await writeFile(temporary, generated.bytes, { flag: 'wx', mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(temporary, path)
    await writeFile(imagePath(asset.id, 'json'), JSON.stringify(asset), { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
  } catch (error) {
    await Promise.all(
      [temporary, path, imagePath(asset.id, 'json')].map((file) => rm(file, { force: true }))
    )
    throw error
  }
  options.onProgress?.({ requestId: request.requestId, stage: 'complete' })
  return asset
}

/** New files only: generation never silently overwrites a user's existing asset. */
export async function saveImageToWorkspace(
  workspacePath: string,
  id: string,
  destination: string
): Promise<string> {
  if (!destination.toLowerCase().endsWith('.png')) throw new Error('Choose a .png destination')
  const target = resolveInWorkspace(workspacePath, destination)
  await readGeneratedImage(id)
  await mkdir(dirname(target), { recursive: true })
  resolveInWorkspace(workspacePath, destination)
  await copyFile(imagePath(id, 'png'), target, constants.COPYFILE_EXCL)
  return target
}
