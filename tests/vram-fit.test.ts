import { describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_HEADROOM_BYTES,
  contextLimits,
  createContextWithVramFallback,
  isMemoryError,
  inferenceBudgetBytes,
  OS_RESERVE_BYTES,
  pickGgufForBudget,
  REPLY_MAX_TOKENS
} from '../electron/main/services/vram-fit'
import {
  contextBudgetTokens,
  needsContextCompaction
} from '../electron/main/services/agent/compaction'
import { getDefaults } from '../electron/main/services/settings'

const GB = 1024 ** 3

describe('VRAM fit', () => {
  it('uses shared free VRAM, then a single GPU, and reserves room from a total', () => {
    expect(
      inferenceBudgetBytes({
        vramShareFreeBytes: 18 * GB,
        preferredFreeBytes: 8 * GB
      })
    ).toBe(18 * GB)
    expect(inferenceBudgetBytes({ preferredFreeBytes: 10 * GB })).toBe(10 * GB)
    expect(inferenceBudgetBytes({ preferredTotalBytes: 16 * GB })).toBe(16 * GB - OS_RESERVE_BYTES)
    expect(inferenceBudgetBytes({})).toBe(0)
  })

  it('keeps built-in Lite at 32k and lets local models use the settings window', () => {
    expect(
      contextLimits({
        tier: 'lite',
        role: 'composer',
        modelContext: 32768,
        settingsContext: 32768
      })
    ).toEqual({ min: 4096, max: 32768 })
    expect(
      contextLimits({
        tier: 'full',
        role: 'local',
        modelContext: 131072,
        settingsContext: 32768
      })
    ).toEqual({ min: 8192, max: 32768 })
    expect(
      contextLimits({
        tier: 'full',
        role: 'local',
        modelContext: 8192,
        settingsContext: 65536
      })
    ).toEqual({ min: 8192, max: 8192 })
  })

  it('compacts from the loaded window and allows a 16k reply', () => {
    expect(REPLY_MAX_TOKENS).toBe(16_384)
    const settings = structuredClone(getDefaults())
    expect(contextBudgetTokens(settings, 'builtin:composer-lite')).toBe(Math.floor(32_768 * 0.65))
    expect(contextBudgetTokens(settings, 'builtin:composer')).toBe(Math.floor(32_768 * 0.65))
  })

  it('compacts from the token budget instead of a message count', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `step ${i}`
    }))
    expect(needsContextCompaction(messages, 20_000, false)).toBe(false)
    const heavy = messages.map((message) => ({ ...message, content: 'x'.repeat(4000) }))
    expect(needsContextCompaction(heavy, 20_000, false)).toBe(true)
  })

  it('picks the highest quant that fits and falls back when none do', () => {
    const files = [
      { path: 'model-Q4_K_M.gguf', sizeBytes: 4 * GB },
      { path: 'model-Q6_K.gguf', sizeBytes: 6 * GB },
      { path: 'model-Q8_0.gguf', sizeBytes: 8 * GB },
      { path: 'mmproj-vision.gguf', sizeBytes: 1 * GB }
    ]
    const roomy = pickGgufForBudget(files, 8 * GB + CONTEXT_HEADROOM_BYTES + 1)
    expect(roomy?.file.path).toBe('model-Q8_0.gguf')
    expect(roomy?.fits).toBe(true)

    const mid = pickGgufForBudget(files, 6 * GB + CONTEXT_HEADROOM_BYTES)
    expect(mid?.file.path).toBe('model-Q6_K.gguf')

    const tight = pickGgufForBudget(files, 4 * GB + CONTEXT_HEADROOM_BYTES)
    expect(tight?.file.path).toBe('model-Q4_K_M.gguf')

    const overflow = pickGgufForBudget(files, 2 * GB)
    expect(overflow?.file.path).toBe('model-Q4_K_M.gguf')
    expect(overflow?.fits).toBe(false)
  })

  it('keeps the Q4 default when VRAM is unknown', () => {
    const picked = pickGgufForBudget(
      [
        { path: 'model-Q8_0.gguf', sizeBytes: 8 * GB },
        { path: 'model-Q4_K_M.gguf', sizeBytes: 4 * GB }
      ],
      0
    )
    expect(picked?.file.path).toBe('model-Q4_K_M.gguf')
    expect(picked?.fits).toBe(false)
  })
})

describe('context allocation recovery', () => {
  const memoryError = (size: number) =>
    new Error(`A context size of ${size} is too large for the available vRAM`)

  it('recovers the reported Windows 8192-token failure without growing the cache', async () => {
    const create = vi.fn(async (options: { contextSize: { min: number; max: number } }) => {
      if (options.contextSize.min > 2048) throw memoryError(options.contextSize.min)
      return { contextSize: 2048 }
    })
    const context = await createContextWithVramFallback(create, { min: 8192, max: 8192 })
    expect(context.contextSize).toBe(2048)
    expect(create.mock.calls.map(([options]) => options.contextSize)).toEqual([
      { min: 8192, max: 8192 },
      { min: 4096, max: 4096 },
      { min: 2048, max: 2048 }
    ])
    for (const [options] of create.mock.calls)
      expect(options).toHaveProperty('experimentalKvCacheKeyType', 'Q8_0')
  })

  it('allows native range selection before reducing the requested minimum', async () => {
    const allocated = { contextSize: 12288 }
    const create = vi.fn().mockResolvedValue(allocated)
    expect(await createContextWithVramFallback(create, { min: 8192, max: 32768 })).toBe(allocated)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].contextSize).toEqual({ min: 8192, max: 32768 })
  })

  it('uses default KV when quantization is unsupported, and can shrink that allocation', async () => {
    const create = vi.fn(
      async (
        options: ReturnType<
          typeof import('../electron/main/services/vram-fit').contextCreateOptions
        >
      ) => {
        if (options.experimentalKvCacheKeyType) throw new Error('Quantized KV is unsupported')
        if (options.contextSize.min > 4096) throw memoryError(options.contextSize.min)
        return { contextSize: 4096 }
      }
    )
    expect(await createContextWithVramFallback(create, { min: 8192, max: 32768 })).toEqual({
      contextSize: 4096
    })
    expect(
      create.mock.calls.map(([options]) => [
        options.contextSize.min,
        !!options.experimentalKvCacheKeyType
      ])
    ).toEqual([
      [8192, true],
      [8192, false],
      [4096, true],
      [4096, false]
    ])
  })

  it('stops at 512 and preserves the real error if even the smallest context fails', async () => {
    const error = memoryError(512)
    const create = vi.fn().mockRejectedValue(error)
    await expect(createContextWithVramFallback(create, { min: 8192, max: 8192 })).rejects.toBe(
      error
    )
    expect(create.mock.calls.map(([options]) => options.contextSize.min)).toEqual([
      8192, 4096, 2048, 1024, 512
    ])
  })

  it('does not shrink contexts for model corruption or other unrelated failures', async () => {
    const error = new Error('Invalid model tensor')
    const create = vi.fn().mockRejectedValue(error)
    await expect(createContextWithVramFallback(create, { min: 8192, max: 8192 })).rejects.toBe(
      error
    )
    expect(create).toHaveBeenCalledTimes(2) // one quantized attempt and one compatibility attempt
  })

  it('recognizes native and serialized memory errors without treating context overflow as OOM', () => {
    expect(isMemoryError(memoryError(8192))).toBe(true)
    expect(isMemoryError('A context size of 8192 is too large for the available RAM')).toBe(true)
    expect(
      isMemoryError(
        Object.assign(new Error('native allocation rejected'), { name: 'InsufficientMemoryError' })
      )
    ).toBe(true)
    expect(isMemoryError(new Error('Prompt exceeds context size'))).toBe(false)
  })
})
