import { describe, it, expect } from 'vitest'
import { searchLoadedHistory } from '../src/shared/chat-history-search'
import { evaluatePerformanceBudget, performanceQuantiles } from '../src/shared/performance-budget'

describe('loaded history search', () => {
  it('finds case-insensitive text crossing chunk boundaries without losing source IDs', async () => {
    const content = 'a'.repeat(16382) + 'NeEdLe' + 'b'.repeat(20000)
    expect(
      await searchLoadedHistory(
        [
          { id: 'offscreen', content },
          { id: 'other', content: 'none' }
        ],
        ' needle '
      )
    ).toEqual(['offscreen'])
    expect(await searchLoadedHistory([{ id: 'empty', content }], '  ')).toEqual([])
  })
  it('cancels stale searches between cooperative batches', async () => {
    const controller = new AbortController()
    await expect(
      searchLoadedHistory(
        Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, content: 'match' })),
        'match',
        controller.signal,
        () => controller.abort()
      )
    ).rejects.toThrow()
  })
})
describe('hardware-scoped performance evidence', () => {
  const hardware = { platform: 'darwin', arch: 'arm64', cpu: 'Apple M4', totalMemoryBytes: 16 }
  const profiles = [
    {
      id: 'fixture',
      ...hardware,
      minMemoryBytes: 15,
      maxMemoryBytes: 17,
      limits: { latency: { p50: 50, p95: 100 } }
    }
  ]
  it('uses nearest-rank quantiles and does not invent missing observations', () => {
    expect(performanceQuantiles(Array.from({ length: 20 }, (_, i) => i + 1))).toMatchObject({
      p50: 10,
      p95: 19
    })
    expect(performanceQuantiles([NaN, -1])).toMatchObject({ p50: null, p95: null })
  })
  it('does not certify unmatched hardware, missing metrics or invalid observations', () => {
    expect(evaluatePerformanceBudget({ ...hardware, cpu: 'other' }, {}, profiles).state).toBe(
      'not-applicable'
    )
    expect(evaluatePerformanceBudget(hardware, {}, profiles).state).toBe('incomplete')
    expect(
      evaluatePerformanceBudget(hardware, { latency: { p50: NaN, p95: Infinity } }, profiles).state
    ).toBe('incomplete')
    expect(
      evaluatePerformanceBudget(hardware, { latency: { p50: 40, p95: 101 } }, profiles).state
    ).toBe('over-budget')
    expect(
      evaluatePerformanceBudget(hardware, { latency: { p50: 40, p95: 90 } }, profiles).state
    ).toBe('within-budget')
  })
})
