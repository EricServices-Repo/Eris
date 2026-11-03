import { describe, expect, it } from 'vitest'
import { measureMemoryBaseline } from '../checks/memory-process-baseline'

/**
 * #228 baseline harness, at test size. The recorded 1 GiB results come from
 * scripts/measure-memory-baseline.cjs in real Electron; this keeps the harness honest.
 */
describe('RAM tier baseline in the current process (#228)', () => {
  it('measures heap, RSS, blocking and GC beside the ledger, with real selections', async () => {
    const report = await measureMemoryBaseline({ stepsMiB: [16, 32] })
    expect(report).toMatchObject({ version: 1, evidence: 'measured-process', stopped: null })
    expect(report.heapSizeLimitMiB).toBeGreaterThan(0)
    expect(report.steps).toHaveLength(2)
    for (const step of report.steps) {
      expect(step.ledgerOwnedMiB as number).toBeGreaterThanOrEqual(
        Math.floor((step.targetMiB as number) * 0.85)
      )
      // Selections that return nothing would make every latency look free.
      expect(step.selectsWithNoFacts).toBe(0)
      expect(step).toHaveProperty('selectMaxBlockMs.max')
      expect(step).toHaveProperty('installMs.max')
    }
  }, 60_000)

  it('records that a tier filled to its envelope returns no recall', async () => {
    const { fullTierRecall } = await measureMemoryBaseline({ stepsMiB: [16] })
    expect(fullTierRecall[0]).toMatchObject({ facts: 0 })
    expect(fullTierRecall[0]!.reason).toMatch(/scratch space was not admitted/)
    expect(fullTierRecall[1]!.facts).toBeGreaterThan(0)
  }, 60_000)
})
