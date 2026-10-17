import { describe, expect, it } from 'vitest'
import {
  CONTEXT_HEADROOM_BYTES,
  contextLimits,
  inferenceBudgetBytes,
  OS_RESERVE_BYTES,
  pickGgufForBudget,
  REPLY_MAX_TOKENS
} from '../electron/main/services/vram-fit'
import { contextBudgetTokens } from '../electron/main/services/agent/compaction'
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

  it('keeps built-in Lite at 16k and lets local models use the settings window', () => {
    expect(
      contextLimits({
        tier: 'lite',
        role: 'composer',
        modelContext: 32768,
        settingsContext: 32768
      })
    ).toEqual({ min: 4096, max: 16384 })
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
    expect(contextBudgetTokens(settings, 'builtin:composer-lite')).toBe(Math.floor(16_384 * 0.65))
    expect(contextBudgetTokens(settings, 'builtin:composer')).toBe(Math.floor(32_768 * 0.65))
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
