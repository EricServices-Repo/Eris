import { describe, expect, it } from 'vitest'
import { modelOffloadLabel } from '../src/shared/memory-usage'
import type { MemoryUsageStatus } from '../src/shared/memory-usage'
const tiers: NonNullable<MemoryUsageStatus['tiers']> = {
  model: { ref: 'local:test', contextSize: 4096, gpuLayers: 32, totalLayers: 32, kvBytes: 1024 },
  devices: [],
  pressure: 'critical',
  pressureReason: 'Recall paused: system memory is low',
  budgetReason: 'Profile cache limit',
  journal: { bytes: 123, searches: 2, evicted: 3, runs: 1 },
  lastDispatch: { model: 'local:test', counts: { selected: 5, sent: 2, omitted: 3, truncated: 0 } }
}
describe('memory-tier diagnostics presentation (#236)', () => {
  it('reports complete measured layer offload', () => {
    expect(modelOffloadLabel(tiers.model)).toBe('Fully on GPU')
  })
  it('distinguishes unknown, partial, CPU and remote residency', () => {
    for (const [model, expected] of [
      [{ ref: 'local:test', contextSize: 2048 }, 'GPU placement unavailable'],
      [{ ...tiers.model!, gpuLayers: 8 }, 'Partially on GPU'],
      [{ ...tiers.model!, gpuLayers: 0 }, 'CPU execution'],
      [null, 'No native model loaded']
    ] as const) {
      expect(modelOffloadLabel(model)).toBe(expected)
      expect(modelOffloadLabel(model)).not.toBe('Fully on GPU')
    }
  })
})
