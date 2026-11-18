import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

/**
 * #677 end to end: a fake Ollama whose `/api/ps` reports a VRAM split computed from the
 * `num_ctx` it was last loaded with, and which can refuse to load past a memory limit.
 */
vi.mock('../electron/main/services/usage-stats', async (original) => ({
  ...(await original<typeof import('../electron/main/services/usage-stats')>()),
  recordModelUsage: () => undefined
}))
const gpu = vi.hoisted(() => ({ status: null as Record<string, unknown> | null }))
vi.mock('../electron/main/services/gpu-accel', async (original) => ({
  ...(await original<typeof import('../electron/main/services/gpu-accel')>()),
  lastGpuAccelStatus: () => gpu.status
}))

import { streamProviderChat } from '../electron/main/services/chat-runtime'
import { resolveModelCapabilities } from '../electron/main/services/model-capabilities'
import { getModelsStatus } from '../electron/main/services/model-catalog'
import {
  clearOllamaRuntimeFacts,
  contextFitMode,
  kvBytesPerToken,
  ollamaRequestWindow,
  placementsFor,
  prepareModelWindows
} from '../electron/main/services/ollama-runtime'
import { MIN_FIT_WINDOW } from '../electron/main/services/ollama-context-fit'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'

const GIB = 1024 ** 3
// 48 layers × 4 KV heads × (128 + 128) × 2 bytes: qwen3-coder:30b at f16.
const PER_TOKEN = 98304

type Fake = {
  weights: number
  vram: number
  maxContext?: number
  /** Real per-token cost, which may differ from the model_info estimate. */
  perToken?: number
  /** Refuse to load when the model would exceed this many bytes. */
  refuseAbove?: number
}

function fakeOllama(fake: Fake) {
  const seen = { numCtx: [] as number[], show: 0 }
  let loaded = 0
  const size = (window: number) => fake.weights + window * (fake.perToken ?? PER_TOKEN)
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      if (request.url === '/api/show') {
        seen.show++
        response.end(
          JSON.stringify({
            model_info: {
              'general.architecture': 'qwen3moe',
              'qwen3moe.context_length': fake.maxContext ?? 262144,
              'qwen3moe.block_count': 48,
              'qwen3moe.attention.head_count': 32,
              'qwen3moe.attention.head_count_kv': 4,
              'qwen3moe.attention.key_length': 128,
              'qwen3moe.attention.value_length': 128
            }
          })
        )
        return
      }
      if (request.url === '/api/ps') {
        const total = size(loaded)
        response.end(
          JSON.stringify({
            models: loaded
              ? [{ name: 'm', size: total, size_vram: Math.min(total, fake.vram), context_length: loaded }]
              : []
          })
        )
        return
      }
      if (request.url === '/api/chat') {
        const numCtx = (JSON.parse(raw) as { options: { num_ctx: number } }).options.num_ctx
        seen.numCtx.push(numCtx)
        if (fake.refuseAbove !== undefined && size(numCtx) > fake.refuseAbove) {
          response.statusCode = 500
          response.end(
            JSON.stringify({ error: 'model requires more system memory (31.0 GiB) than is available (24.0 GiB)' })
          )
          return
        }
        loaded = numCtx
        response.write('{"message":{"content":"ok"},"done":false}\n')
        response.end('{"message":{"content":""},"done":true,"done_reason":"stop"}\n')
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
  })
  return { server, seen }
}

let server: Server | undefined
const start = (s: Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`))
  )
const connectionAt = (baseUrl: string, over: Partial<ModelConnection> = {}): ModelConnection => ({
  id: 'ollama',
  name: 'Ollama',
  type: 'openai-compatible',
  provider: 'ollama',
  enabled: true,
  baseUrl,
  apiKeyRef: '',
  models: ['m'],
  ...over
})
const settingsFor = (connection: ModelConnection, contextWindow = 131072, extra: Partial<AppSettings['models']> = {}) =>
  ({
    models: { connections: [connection], contextWindow, capabilityProfiles: {}, ...extra },
    agent: { contextMemory: {} }
  }) as unknown as AppSettings

async function send(settings: AppSettings, content = 'hi') {
  let text = ''
  for await (const chunk of streamProviderChat({
    settings,
    model: 'm',
    messages: [{ role: 'user', content }],
    temperature: 0,
    getSecret: () => null
  } as never))
    text += chunk
  // Placement is observed after the stream, without being awaited.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return text
}

async function setup(fake: Fake, over: Partial<ModelConnection> = {}, contextWindow?: number, extra?: Partial<AppSettings['models']>) {
  const made = fakeOllama(fake)
  server = made.server
  const connection = connectionAt(await start(server), over)
  const settings = settingsFor(connection, contextWindow, extra)
  await prepareModelWindows(settings, ['m'], () => null)
  return { ...made, connection, settings }
}

beforeEach(() => {
  clearOllamaRuntimeFacts()
  gpu.status = null
})
afterEach(() => {
  server?.close()
  server = undefined
})

describe('fit (default)', () => {
  it('shrinks the next request after a spill, and the prompt budget with it', async () => {
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB })
    await send(settings)
    expect(seen.numCtx[0]).toBe(131072)
    const fitted = ollamaRequestWindow(connection, 'm', 131072)!
    expect(fitted).toBeLessThan(131072)
    // What the fitted window costs fits in the VRAM.
    expect(19 * GIB + fitted * PER_TOKEN).toBeLessThanOrEqual(24 * GIB)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(fitted)
    await send(settings)
    expect(seen.numCtx[1]).toBe(fitted)
    expect(placementsFor(connection)[0]).toMatchObject({
      vramBytes: 19 * GIB + fitted * PER_TOKEN,
      fittedWindow: fitted,
      fitReason: 'spill'
    })
  })

  /** The best window for a spill at `window`: what fitAfterSpill gives with the true cost. */
  const best = (perToken: number) => {
    const spill = 19 * GIB + 131072 * perToken - 24 * GIB
    return Math.floor((131072 - Math.ceil((spill + 256 * 1024 ** 2) / perToken)) / 1024) * 1024
  }

  it('grows back to the best window once the cost is measured, when the estimate was low', async () => {
    // The real cache is 1.25× the model_info estimate, as with a second parallel slot.
    const real = PER_TOKEN * 1.25
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB, perToken: real })
    await send(settings)
    await send(settings)
    // The estimate removed too many tokens: the second load fits with room to spare.
    expect(seen.numCtx[1]).toBeLessThan(best(real))
    expect(kvBytesPerToken(connection, 'm')).toBe(real)
    await send(settings)
    await send(settings)
    expect(seen.numCtx[2]).toBe(best(real))
    expect(seen.numCtx[3]).toBe(best(real))
    expect(19 * GIB + best(real) * real).toBeLessThanOrEqual(24 * GIB)
    expect(placementsFor(connection)[0]!.vramBytes).toBe(placementsFor(connection)[0]!.sizeBytes)
  })

  it('converges when the estimate was high (for example a compressed cache)', async () => {
    const real = PER_TOKEN / 4
    const { seen, settings, connection } = await setup({ weights: 22 * GIB, vram: 24 * GIB, perToken: real })
    for (let i = 0; i < 5; i++) await send(settings)
    expect(kvBytesPerToken(connection, 'm')).toBe(real)
    const last = seen.numCtx[seen.numCtx.length - 1]!
    expect(seen.numCtx[seen.numCtx.length - 2]).toBe(last)
    expect(22 * GIB + last * real).toBeLessThanOrEqual(24 * GIB)
    // Within one fit step and the headroom of the largest window that fits.
    expect(22 * GIB + (last + 1024) * real + 256 * 1024 ** 2).toBeGreaterThan(24 * GIB)
  })

  it('stops at the floor and reports weights that do not fit', async () => {
    const { seen, settings, connection } = await setup({ weights: 30 * GIB, vram: 24 * GIB })
    for (let i = 0; i < 3; i++) await send(settings)
    expect(seen.numCtx).toEqual([131072, MIN_FIT_WINDOW, MIN_FIT_WINDOW])
    expect(placementsFor(connection)[0]).toMatchObject({ weightsExceedVram: true, fittedWindow: MIN_FIT_WINDOW })
  })

  it('applies a fit only to the requested window it was made for', async () => {
    const { settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB })
    await send(settings)
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBeLessThan(131072)
    expect(ollamaRequestWindow(connection, 'm', 16384)).toBe(16384)
  })

  it('forgets a fit made under other fit settings, and on request', async () => {
    const { settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB })
    await send(settings)
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBeLessThan(131072)
    expect(ollamaRequestWindow({ ...connection, kvCacheType: 'q8_0' }, 'm', 131072)).toBe(131072)
    await getModelsStatus(settings, () => null, { resetContextFit: connection.id })
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBe(131072)
    expect(placementsFor(connection)).toEqual([])
  })
})

describe('off', () => {
  it('sends the requested window every time', async () => {
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB }, { contextFit: 'off' })
    await send(settings)
    await send(settings)
    expect(seen.numCtx).toEqual([131072, 131072])
    expect(placementsFor(connection)[0]!.fittedWindow).toBeUndefined()
  })

  it('is forced for Eris Cloud and anything that is not Ollama', () => {
    expect(contextFitMode(connectionAt('https://agents.ericservic.es/v1', { id: 'eris-cloud' }))).toBe('off')
    expect(contextFitMode(connectionAt('http://127.0.0.1:1234/v1', { id: 'lm', provider: 'lmstudio' }))).toBe('off')
    expect(contextFitMode(connectionAt('http://127.0.0.1:11435/v1', { id: 'conn-b' }))).toBe('fit')
  })
})

describe('max', () => {
  it('grows to the largest window the declared VRAM holds, capped at the model maximum', async () => {
    const { seen, settings, connection } = await setup(
      { weights: 19 * GIB, vram: 30 * GIB, maxContext: 262144 },
      { contextFit: 'max', vramGiB: 30 },
      32768
    )
    await send(settings)
    expect(seen.numCtx[0]).toBe(32768)
    const planned = ollamaRequestWindow(connection, 'm', 32768)!
    expect(planned).toBeGreaterThan(32768)
    expect(planned).toBeLessThanOrEqual(262144)
    expect(19 * GIB + planned * PER_TOKEN).toBeLessThanOrEqual(30 * GIB)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(planned)
    await send(settings)
    expect(seen.numCtx[1]).toBe(planned)
    // Stays in VRAM, so no oscillation: the next request keeps the plan.
    await send(settings)
    expect(seen.numCtx[2]).toBe(planned)
    expect(placementsFor(connection)[0]).toMatchObject({ fitReason: 'vram-plan' })
  })

  it('uses this computer’s GPUs for a loopback server with no declaration', async () => {
    gpu.status = {
      devices: [
        { name: 'RTX 3060', kind: 'discrete', vramBytes: 12 * GIB, index: 0 },
        { name: 'RTX 3060', kind: 'discrete', vramBytes: 12 * GIB, index: 1 }
      ],
      vramShareTotalBytes: 24 * GIB
    }
    const { settings, connection } = await setup(
      { weights: 19 * GIB, vram: 24 * GIB },
      { contextFit: 'max' },
      16384
    )
    await send(settings)
    const planned = ollamaRequestWindow(connection, 'm', 16384)!
    expect(planned).toBeGreaterThan(16384)
    expect(19 * GIB + planned * PER_TOKEN).toBeLessThanOrEqual(24 * GIB)
  })

  it('shrinks a plan that turns out too large, and does not plan again', async () => {
    // Declared 40 GiB, but the server only has 24.
    const { seen, settings } = await setup(
      { weights: 19 * GIB, vram: 24 * GIB },
      { contextFit: 'max', vramGiB: 40 },
      16384
    )
    await send(settings)
    await send(settings)
    const plannedTooBig = seen.numCtx[1]!
    expect(19 * GIB + plannedTooBig * PER_TOKEN).toBeGreaterThan(24 * GIB)
    await send(settings)
    await send(settings)
    const settled = seen.numCtx[3]!
    expect(seen.numCtx[2]).toBe(settled)
    expect(19 * GIB + settled * PER_TOKEN).toBeLessThanOrEqual(24 * GIB)
  })

  it('still grows when a saved capability profile only repeats the global window', async () => {
    const profile = { tier: 'strong', toolCalling: 'native', contextWindow: 32768, reasoning: false, vision: false, costClass: 'free-local' }
    const { seen, settings } = await setup(
      { weights: 19 * GIB, vram: 30 * GIB },
      { contextFit: 'max', vramGiB: 30 },
      32768,
      { capabilityProfiles: { m: profile } } as never
    )
    await send(settings)
    await send(settings)
    expect(seen.numCtx[1]).toBeGreaterThan(32768)
    server?.close()
    // A profile window that differs from the global one is the user's choice.
    const pinned = await setup(
      { weights: 19 * GIB, vram: 30 * GIB },
      { contextFit: 'max', vramGiB: 30 },
      32768,
      { capabilityProfiles: { m: { ...profile, contextWindow: 49152 } } } as never
    )
    await send(pinned.settings)
    await send(pinned.settings)
    expect(pinned.seen.numCtx).toEqual([49152, 49152])
  })

  it('never grows past a window the user set for the model', async () => {
    const { seen, settings, connection } = await setup(
      { weights: 19 * GIB, vram: 30 * GIB },
      { contextFit: 'max', vramGiB: 30, modelLimits: { m: { contextWindow: 32768 } } },
      8192
    )
    await send(settings)
    await send(settings)
    expect(seen.numCtx).toEqual([32768, 32768])
    expect(ollamaRequestWindow(connection, 'm', 32768, { explicit: true })).toBe(32768)
  })
})

describe('out of memory', () => {
  it('retries only once', async () => {
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB, refuseAbove: 24 * GIB })
    await expect(send(settings)).rejects.toThrow(/65,536-token window .* Eris will use 32,768 tokens/)
    expect(seen.numCtx).toEqual([131072, 65536])
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBe(32768)
  })

  it('retries once at a smaller window and succeeds', async () => {
    // 131,072 needs 31 GiB and is refused; 65,536 needs 25 GiB and loads.
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 26 * GIB, refuseAbove: 26 * GIB })
    expect(await send(settings)).toBe('ok')
    expect(seen.numCtx).toEqual([131072, 65536])
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBe(65536)
  })

  it('fails with the new window when the prompt would not fit it', async () => {
    const { seen, settings, connection } = await setup({ weights: 19 * GIB, vram: 24 * GIB, refuseAbove: 24 * GIB })
    // About 75K tokens: fits 131,072 but not 65,536.
    const big = 'word '.repeat(60_000)
    await expect(send(settings, big)).rejects.toThrow(
      /could not load m with a 131,072-token window \(out of memory\)\. Eris will use 65,536 tokens/
    )
    expect(seen.numCtx).toEqual([131072])
    expect(ollamaRequestWindow(connection, 'm', 131072)).toBe(65536)
  })

  it('keeps the original error as the cause', async () => {
    const { settings } = await setup({ weights: 19 * GIB, vram: 24 * GIB, refuseAbove: 24 * GIB })
    const error = await send(settings).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error & { cause?: Error }).cause?.message)).toMatch(/requires more system memory/)
  })

  it('does not retry when fitting is off', async () => {
    const { seen, settings } = await setup(
      { weights: 19 * GIB, vram: 24 * GIB, refuseAbove: 24 * GIB },
      { contextFit: 'off' }
    )
    await expect(send(settings)).rejects.toThrow(/requires more system memory/)
    expect(seen.numCtx).toEqual([131072])
  })
})
