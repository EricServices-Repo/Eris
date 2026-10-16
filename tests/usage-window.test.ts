import { describe, expect, it } from 'vitest'
import { rollingDayKeys, sumDayTotals } from '../electron/main/services/usage-stats'

describe('rolling usage window', () => {
  it('returns 30 local calendar days ending on the given date', () => {
    const keys = rollingDayKeys(30, new Date(2026, 9, 16))
    expect(keys).toHaveLength(30)
    expect(keys[0]).toBe('2026-09-17')
    expect(keys[keys.length - 1]).toBe('2026-10-16')
    expect(new Set(keys).size).toBe(30)
  })

  it('sums day totals for the window', () => {
    expect(
      sumDayTotals([
        { requests: 1, inputTokens: 10, outputTokens: 4, cloudJobs: 1 },
        { requests: 2, inputTokens: 5, outputTokens: 1, cloudJobs: 0 }
      ])
    ).toEqual({
      requests: 3,
      inputTokens: 15,
      outputTokens: 5,
      cloudJobs: 1
    })
  })
})
