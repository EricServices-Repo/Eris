import { describe, expect, it } from 'vitest'
import { measureMemoryBaseline } from '../checks/memory-process-baseline'

/**
 * #228 baseline harness, at test size. The recorded 1 GiB results come from
 * scripts/measure-memory-baseline.cjs in real Electron; this keeps the harness honest.
 */
describe('RAM tier baseline in the current process (#228)', () => {
  it('measures heap, RSS, blocking and GC beside the ledger, with real selections', async () => {
    const report = await measureMemoryBaseline({ stepsMiB: [16, 32] })
    expect(report).toMatchObject({
      version: 2,
      install: 'segments',
      evidence: 'measured-process',
      stopped: null
    })
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
      expect(step).toHaveProperty('installMaxBlockMs.max')
    }
  }, 60_000)

  it('times the production paged install, which yields, apart from the one-call install', async () => {
    const paged = await measureMemoryBaseline({ stepsMiB: [32] })
    const sync = await measureMemoryBaseline({ stepsMiB: [32], install: 'sync' })
    const block = (report: typeof paged) =>
      (report.steps[0]!.installMaxBlockMs as { max: number }).max
    const total = (report: typeof sync) => (report.steps[0]!.installMs as { max: number }).max
    expect(sync.install).toBe('sync')
    // The one-call install blocks for its whole duration; the paged path does not.
    expect(block(sync)).toBeGreaterThanOrEqual(total(sync) * 0.9)
    expect(block(paged)).toBeLessThan(block(sync) / 4)
  }, 120_000)

  it('records that a tier filled to its envelope returns no recall', async () => {
    const { fullTierRecall } = await measureMemoryBaseline({ stepsMiB: [16] })
    expect(fullTierRecall[0]).toMatchObject({ facts: 0 })
    expect(fullTierRecall[0]!.reason).toMatch(/scratch space was not admitted/)
    expect(fullTierRecall[1]!.facts).toBeGreaterThan(0)
  }, 60_000)
})
