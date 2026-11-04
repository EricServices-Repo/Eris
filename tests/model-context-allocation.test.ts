import { recordProviderContexts } from '../electron/main/services/provider-context'
import { modelInputBudget } from '../src/shared/model-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/shared/settings-schema'

const G = 1024 ** 3
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'big',
  ref: 'local:big',
  contextWindow: 131072,
  approxBytes: 9 * G,
  role: 'local',
  tier: 'full',
  ...over
})
const harness = vi.hoisted(() => ({
  local: null as null | Record<string, unknown>,
  builtin: null as null | Record<string, unknown>,
  vram: undefined as undefined | number
}))
vi.mock('../electron/main/services/local-model', () => ({
  isLocalRef: (ref: string) => ref.startsWith('local:'),
  findLocalEntry: () => harness.local,
  localEntryAsBuiltin: (local: unknown) => local
}))
vi.mock('../electron/main/services/tool-protocol', () => ({ toolProtocolFor: () => 'text-tools' }))
vi.mock('../electron/main/services/gpu-accel', async (original) => ({
  ...(await original<object>()),
  lastGpuAccelStatus: () => (harness.vram === undefined ? null : { vramBudgetBytes: harness.vram })
}))
vi.mock('../electron/main/services/builtin-model', async (original) => {
  const actual = await original<typeof import('../electron/main/services/builtin-model')>()
  return { ...actual, findBuiltinEntry: () => harness.builtin }
})

import {
  contextProvenance,
  resolveModelCapabilities
} from '../electron/main/services/model-capabilities'
import { contextBudgetTokens } from '../electron/main/services/agent/context-budget'
import {
  clearLoadedModel,
  loadedModelFacts,
  recordLoadedModel
} from '../electron/main/services/model-runtime'
import { allocationFacts } from '../electron/main/services/vram-fit'

const settings = { models: { connections: [], contextWindow: 32768 } } as unknown as AppSettings

beforeEach(() => {
  harness.local = entry()
  harness.builtin = null
  harness.vram = 12 * G
})
afterEach(() => clearLoadedModel())

describe('native context capacity', () => {
  it('budgets the 9 GiB model on a 12 GiB GPU against its 8K plan, not the 32K setting', () => {
    const capabilities = resolveModelCapabilities(settings, 'local:big')
    expect(capabilities).toMatchObject({
      contextCeiling: 8192,
      contextSource: 'runtime-plan',
      promptBudget: modelInputBudget(8192, Math.floor(8192 * 0.3))
    })
    expect(contextBudgetTokens(settings, 'local:big')).toBeLessThan(8192)
  })
  it('prefers the measured allocation once loaded', () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 6144 })
    expect(resolveModelCapabilities(settings, 'local:big')).toMatchObject({
      contextCeiling: 6144,
      contextSource: 'measured-allocation',
      promptBudget: modelInputBudget(6144, Math.floor(6144 * 0.3))
    })
  })
  it('never applies one model’s allocation to another', () => {
    recordLoadedModel({ ref: 'local:other', contextSize: 2048 })
    expect(resolveModelCapabilities(settings, 'local:big').contextSource).toBe('runtime-plan')
  })
  it('returns to the plan after the model unloads', () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 6144 })
    clearLoadedModel()
    expect(loadedModelFacts('local:big')).toBeNull()
    expect(resolveModelCapabilities(settings, 'local:big').contextCeiling).toBe(8192)
  })
  it('falls back to model size when the GPU has not been probed', () => {
    harness.vram = undefined
    expect(resolveModelCapabilities(settings, 'local:big').contextCeiling).toBe(8192)
  })
  it('keeps the requested window when the GPU has room', () => {
    harness.vram = 24 * G
    expect(resolveModelCapabilities(settings, 'local:big').contextCeiling).toBe(32768)
  })
  it('applies a built-in model’s own allocation', () => {
    harness.builtin = entry({ id: 'lite', ref: 'builtin:lite', role: 'full', tier: 'lite' })
    recordLoadedModel({ ref: 'builtin:lite', contextSize: 4096 })
    expect(resolveModelCapabilities(settings, 'builtin:lite')).toMatchObject({
      contextCeiling: 4096,
      contextSource: 'measured-allocation'
    })
  })
  it('leaves remote models on the configured ceiling', () => {
    expect(resolveModelCapabilities(settings, 'gpt-5')).toMatchObject({
      contextCeiling: 32768,
      contextSource: 'configured-ceiling'
    })
  })
  it('falls back to the configured ceiling for an unknown local model', () => {
    harness.local = null
    expect(resolveModelCapabilities(settings, 'local:gone').contextSource).toBe(
      'configured-ceiling'
    )
  })
  it('exposes the source and the value for compile events', () => {
    expect(contextProvenance(settings, 'local:big')).toEqual({
      source: 'runtime-plan',
      tokens: 8192
    })
  })
})

describe('allocation records', () => {
  it('ignores an unusable size instead of budgeting to zero', () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 0 })
    expect(loadedModelFacts('local:big')).toBeNull()
  })
  it('reads the allocation node-llama-cpp reports', () => {
    expect(
      allocationFacts(
        { trainContextSize: 131072, gpuLayers: 40, fileInsights: { totalLayers: 41 } },
        { contextSize: 8192 }
      )
    ).toEqual({ contextSize: 8192, trainContextSize: 131072, gpuLayers: 40, totalLayers: 41 })
  })
  it('tolerates a runtime without those fields', () => {
    expect(allocationFacts({}, null).contextSize).toBeUndefined()
  })
})

describe('large model windows', () => {
  it.each([8192, 16384, 32768, 65536, 128000, 250000, 262144, 1010000, 2097152])(
    'keeps a configured %i provider window without hidden clamps',
    (window) => {
      const configured = {
        models: { connections: [], contextWindow: window }
      } as unknown as AppSettings
      const cap = resolveModelCapabilities(configured, 'hosted-model')
      expect(cap.contextCeiling).toBe(window)
      expect(cap.promptBudget + cap.outputReserve).toBeLessThan(window)
      if (window >= 250000) expect(cap.promptBudget).toBeGreaterThan(window * 0.9)
    }
  )
  it('uses endpoint-scoped declarations without changing other models or claiming measurement', () => {
    const configured = {
      models: {
        contextWindow: 32768,
        connections: [
          {
            id: 'hosted',
            type: 'openai-compatible',
            enabled: true,
            provider: 'custom',
            baseUrl: 'https://example.com/v1',
            models: ['large', 'small'],
            modelLimits: {
              large: { contextWindow: 262144, maxOutputTokens: 32768 },
              small: { contextWindow: 8192 }
            }
          }
        ]
      }
    } as unknown as AppSettings
    expect(resolveModelCapabilities(configured, 'large')).toMatchObject({
      requestedContext: 262144,
      contextCeiling: 262144,
      outputCap: 32768,
      contextSource: 'user-declared'
    })
    expect(resolveModelCapabilities(configured, 'small').contextCeiling).toBe(8192)
  })
  it('respects a small measured allocation after planning a large local window', () => {
    harness.local = entry({ contextWindow: 262144 })
    harness.vram = 48 * G
    const configured = {
      models: { connections: [], contextWindow: 262144 }
    } as unknown as AppSettings
    expect(resolveModelCapabilities(configured, 'local:big').contextCeiling).toBe(262144)
    recordLoadedModel({ ref: 'local:big', contextSize: 8192, trainContextSize: 262144 })
    expect(resolveModelCapabilities(configured, 'local:big').contextCeiling).toBe(8192)
  })
})

describe('provider-advertised windows', () => {
  it('caps declarations by provider metadata and never applies one endpoint to another', () => {
    recordProviderContexts('https://small.example/v1', [
      { id: 'm', max_model_len: 8192, max_output_tokens: 1024 }
    ])
    const configured = (url: string) =>
      ({
        models: {
          contextWindow: 262144,
          connections: [
            {
              id: 'c',
              provider: 'custom',
              type: 'openai-compatible',
              enabled: true,
              baseUrl: url,
              models: ['m'],
              modelLimits: { m: { contextWindow: 262144, maxOutputTokens: 32768 } }
            }
          ]
        }
      }) as unknown as AppSettings
    expect(resolveModelCapabilities(configured('https://small.example/v1'), 'm')).toMatchObject({
      contextCeiling: 8192,
      contextSource: 'provider-declared',
      outputCap: 1024
    })
    expect(
      resolveModelCapabilities(configured('https://different.example/v1'), 'm').contextCeiling
    ).toBe(262144)
    recordProviderContexts('https://small.example/v1', [{ id: 'm', context_length: NaN }])
    expect(
      resolveModelCapabilities(configured('https://small.example/v1'), 'm').contextSource
    ).toBe('user-declared')
  })
})

describe('context setting changes', () => {
  it('does not reuse a smaller allocation from an old request after increasing the setting', () => {
    harness.local = entry({ contextWindow: 262144 })
    harness.vram = 48 * G
    recordLoadedModel({ ref: 'local:big', contextSize: 8192, requestedContext: 32768 })
    const configured = {
      models: { connections: [], contextWindow: 262144 }
    } as unknown as AppSettings
    expect(resolveModelCapabilities(configured, 'local:big')).toMatchObject({
      contextCeiling: 262144,
      contextSource: 'runtime-plan'
    })
    recordLoadedModel({ ref: 'local:big', contextSize: 16384, requestedContext: 262144 })
    expect(resolveModelCapabilities(configured, 'local:big')).toMatchObject({
      contextCeiling: 16384,
      contextSource: 'measured-allocation'
    })
  })
})
