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
      promptBudget: Math.floor(8192 * 0.65)
    })
    expect(contextBudgetTokens(settings, 'local:big')).toBeLessThan(8192)
  })
  it('prefers the measured allocation once loaded', () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 6144 })
    expect(resolveModelCapabilities(settings, 'local:big')).toMatchObject({
      contextCeiling: 6144,
      contextSource: 'measured-allocation',
      promptBudget: Math.floor(6144 * 0.65)
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
