import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { storageFailures } from '../electron/main/services/evidence-records'
import { userDataRoot } from '../electron/main/services/paths'
import {
  clearUsageStats,
  getUsageSnapshot,
  recordModelUsage,
  rollingDayKeys,
  sumDayTotals
} from '../electron/main/services/usage-stats'

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

describe('usage.json durability', () => {
  const usagePath = () => join(userDataRoot(), 'usage.json')

  it('quarantines an unreadable usage file instead of overwriting it', () => {
    mkdirSync(userDataRoot(), { recursive: true })
    writeFileSync(usagePath(), '{"version":1,"days":{"2026-11-0')
    recordModelUsage({ model: 'builtin:composer-lite', inputTokens: 10, outputTokens: 2 })

    const quarantined = readdirSync(userDataRoot()).filter((name) =>
      name.startsWith('usage.json.corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(userDataRoot(), quarantined[0]!), 'utf8')).toBe(
      '{"version":1,"days":{"2026-11-0'
    )
    // The failure is recorded, then cleared by the successful fresh write that follows.
    expect(storageFailures().some((failure) => failure.path === usagePath())).toBe(false)
    expect(getUsageSnapshot().today.totalRequests).toBe(1)
  })

  it('writes through a temporary file and leaves no partial files behind', () => {
    clearUsageStats()
    recordModelUsage({ model: 'gpt-x', provider: 'openai', inputTokens: 5, outputTokens: 5 })
    expect(JSON.parse(readFileSync(usagePath(), 'utf8')).days).toBeTypeOf('object')
    expect(readdirSync(userDataRoot()).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(usagePath())).toBe(true)
  })
})
