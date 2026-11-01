import { describe, expect, it, vi } from 'vitest'

import {
  CpuSpillRefusedError,
  PLACEMENT_MIN_WINDOW,
  allocationFacts,
  cpuOnlyOptions,
  createContextWithVramFallback,
  fullOffloadOptions,
  modelLoadOptions,
  placeModel
} from '../electron/main/services/vram-fit'

const noMemory = () =>
  Object.assign(new Error('Not enough VRAM'), { name: 'InsufficientMemoryError' })

/** Shaped on a real 1.5B model on capped Metal: see docs/fixes/230-vram-first-placement.md. */
function device(options: { allLayersFit?: boolean; biggestWindow?: number }) {
  const loads: Array<{ gpuLayers: unknown }> = []
  const disposed = vi.fn()
  const load = vi.fn(async (next: { gpuLayers: unknown }) => {
    loads.push(next)
    if (next.gpuLayers === 'max' && options.allLayersFit === false) throw noMemory()
    return { offload: next.gpuLayers === 'max' ? 'all' : 'partial' }
  })
  const createContext = vi.fn(
    async (model: { offload: string }, next: { contextSize: { min: number; max: number } }) => {
      const biggest = model.offload === 'all' ? (options.biggestWindow ?? Infinity) : Infinity
      if (next.contextSize.min > biggest) throw noMemory()
      return { contextSize: Math.min(next.contextSize.max, biggest) }
    }
  )
  return { load, createContext, disposeModel: disposed, loads, disposed }
}
const place = (
  hardware: ReturnType<typeof device>,
  extra: Partial<Parameters<typeof placeModel>[0]> = {}
) =>
  placeModel({
    ...hardware,
    modelPath: 'm.gguf',
    plan: { min: 8_192, target: 32_768 },
    gpu: true,
    allowCpuSpill: true,
    ...(extra as object)
  })

describe('placeModel', () => {
  it('asks for every layer, not a layer count fitted to the window', async () => {
    const hardware = device({})
    await place(hardware)
    expect(hardware.loads[0]).toEqual(fullOffloadOptions('m.gguf'))
    expect(fullOffloadOptions('m').gpuLayers).toBe('max')
  })

  it('keeps the target window when everything fits', async () => {
    const { context, placement } = await place(device({}))
    expect(context).toEqual({ contextSize: 32_768 })
    expect(placement).toEqual({
      allowedSpill: false,
      steps: [{ stage: 'context', window: 32_768, outcome: 'placed' }]
    })
  })

  it('never spills a model that fits fully at a smaller window', async () => {
    const hardware = device({ biggestWindow: 12_800 })
    const { model, context, placement } = await place(hardware)
    expect(model).toEqual({ offload: 'all' })
    expect(context).toEqual({ contextSize: 12_800 })
    expect(placement.allowedSpill).toBe(false)
    expect(hardware.loads.every((load) => load.gpuLayers === 'max')).toBe(true)
  })

  it('goes as low as the floor before giving up on the GPU', async () => {
    const { context, placement } = await place(device({ biggestWindow: PLACEMENT_MIN_WINDOW }))
    expect(context).toEqual({ contextSize: PLACEMENT_MIN_WINDOW })
    expect(placement.allowedSpill).toBe(false)
  })

  it('spills when the weights do not fit, and records why', async () => {
    const hardware = device({ allLayersFit: false })
    const { model, placement } = await place(hardware)
    expect(model).toEqual({ offload: 'partial' })
    expect(placement.allowedSpill).toBe(true)
    expect(placement.steps).toEqual([
      { stage: 'all-layers', window: 32_768, outcome: 'did-not-fit', reason: 'Not enough VRAM' },
      { stage: 'cpu-spill', window: PLACEMENT_MIN_WINDOW, outcome: 'placed' }
    ])
  })

  it('frees the weights before spilling when no window fits beside them', async () => {
    const hardware = device({ biggestWindow: PLACEMENT_MIN_WINDOW - 1 })
    const { placement } = await place(hardware)
    expect(hardware.disposed).toHaveBeenCalledTimes(1)
    expect(placement.steps[0]).toMatchObject({ stage: 'context', outcome: 'did-not-fit' })
    expect(placement.allowedSpill).toBe(true)
  })

  it('keeps a window for the context when it spills, so layers cannot take everything', async () => {
    const hardware = device({ allLayersFit: false })
    await place(hardware)
    expect(hardware.loads[1]).toEqual(modelLoadOptions('m.gguf', PLACEMENT_MIN_WINDOW, false))
  })

  it('falls back to reserving the target, because that loads where the floor cannot', async () => {
    const hardware = device({ allLayersFit: false })
    const failed = vi.fn(async (model: { offload: string }, options: never) => {
      void model
      void options
      if (hardware.loads.length < 3) throw noMemory()
      return { contextSize: 32_768 }
    })
    const { context, placement } = await place(hardware, { createContext: failed as never })
    expect(context).toEqual({ contextSize: 32_768 })
    expect(hardware.loads[2]).toEqual(modelLoadOptions('m.gguf', 32_768, false))
    expect(hardware.disposed).toHaveBeenCalledTimes(1)
    expect(placement.steps.map((step) => [step.stage, step.window, step.outcome])).toEqual([
      ['all-layers', 32_768, 'did-not-fit'],
      ['cpu-spill', PLACEMENT_MIN_WINDOW, 'did-not-fit'],
      ['cpu-spill', 32_768, 'placed']
    ])
  })

  it('ends on CPU only, so a model that loaded before never fails outright', async () => {
    const hardware = device({ allLayersFit: false })
    const roomless = vi.fn(async (model: { offload: string }, options: never) => {
      void model
      void options
      if (hardware.loads.at(-1)?.gpuLayers !== 0) throw noMemory()
      return { contextSize: 32_768 }
    })
    const { placement } = await place(hardware, { createContext: roomless as never })
    expect(hardware.loads.at(-1)).toEqual(cpuOnlyOptions('m.gguf'))
    expect(hardware.disposed).toHaveBeenCalledTimes(2)
    expect(placement.allowedSpill).toBe(true)
    expect(placement.steps.at(-1)).toMatchObject({ stage: 'cpu-spill', outcome: 'placed' })
  })

  it('refuses when spill is off, naming the setting', async () => {
    const hardware = device({ allLayersFit: false })
    const failure = await place(hardware, { allowCpuSpill: false }).catch((error) => error)
    expect(failure).toBeInstanceOf(CpuSpillRefusedError)
    expect(failure.message).toContain('Allow CPU layers')
    expect(failure.steps).toHaveLength(1)
    expect(hardware.loads).toHaveLength(1)
  })

  it('leaves nothing loaded after refusing', async () => {
    const hardware = device({ biggestWindow: 100 })
    await place(hardware, { allowCpuSpill: false }).catch(() => undefined)
    expect(hardware.disposed).toHaveBeenCalledTimes(1)
  })

  it('does not hide a corrupt file behind the ladder', async () => {
    const hardware = device({})
    hardware.load.mockRejectedValueOnce(new Error('GGUF parse failed'))
    await expect(place(hardware)).rejects.toThrow('GGUF parse failed')
    expect(hardware.load).toHaveBeenCalledTimes(1)
  })

  it('does not report a spill with no GPU to place on', async () => {
    const hardware = device({})
    const { placement } = await place(hardware, { gpu: false, allowCpuSpill: false })
    expect(placement).toEqual({ allowedSpill: false, steps: [] })
    expect(hardware.loads[0]).toEqual(modelLoadOptions('m.gguf', 32_768, false))
  })

  it('never asks for a window below a target that is already small', async () => {
    const hardware = device({})
    const { context } = await place(hardware, { plan: { min: 512, target: 2_048 } })
    expect(context).toEqual({ contextSize: 2_048 })
  })
})

describe('createContextWithVramFallback floor', () => {
  it('stops shrinking at the floor it was given', async () => {
    const create = vi.fn(async (_options: { contextSize: { min: number } }): Promise<never> => {
      throw noMemory()
    })
    await expect(
      createContextWithVramFallback(create, { min: 8_192, max: 32_768 }, 4_096)
    ).rejects.toThrow('Not enough VRAM')
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ contextSize: { min: 4_096 } })
  })
})

describe('reporting', () => {
  it('reports layers, window and estimated KV from the loaded model', () => {
    const facts = allocationFacts(
      {
        gpuLayers: 28,
        trainContextSize: 32_768,
        fileInsights: {
          totalLayers: 33,
          estimateContextResourceRequirements: () => ({ gpuVram: 700, cpuRam: 50 })
        }
      },
      { contextSize: 8_192 }
    )
    expect(facts).toMatchObject({
      gpuLayers: 28,
      totalLayers: 33,
      contextSize: 8_192,
      kvBytes: 750
    })
  })

  it('still reports the rest when the KV estimate is unavailable', () => {
    const facts = allocationFacts(
      { gpuLayers: 1, fileInsights: { totalLayers: 1 } },
      { contextSize: 1 }
    )
    expect(facts).toMatchObject({ gpuLayers: 1, kvBytes: undefined })
  })
})
