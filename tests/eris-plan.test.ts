import { describe, expect, it } from 'vitest'
import {
  FREE_PLAN_LIMITS,
  PRO_PLAN_LIMITS,
  meterAgainstLimit,
  normalizeErisPlanId,
  parseErisPlanFromProfile
} from '../src/shared/eris-plan'

describe('eris plan', () => {
  it('normalizes plan ids from Control Hub', () => {
    expect(normalizeErisPlanId('pro')).toBe('pro')
    expect(normalizeErisPlanId('PRO')).toBe('pro')
    expect(normalizeErisPlanId('premium')).toBe('pro')
    expect(normalizeErisPlanId('free')).toBe('free')
    expect(normalizeErisPlanId(undefined)).toBe('free')
  })

  it('parses Free defaults and Pro unlimited from profile.erisPlan', () => {
    expect(parseErisPlanFromProfile({ erisPlan: 'pro' }).limits).toEqual(PRO_PLAN_LIMITS)
    expect(parseErisPlanFromProfile({ erisPlan: 'free' }).limits).toEqual(FREE_PLAN_LIMITS)
    expect(
      parseErisPlanFromProfile({
        erisPlan: 'free',
        erisLimits: { dailyRequests: 20, dailyTokens: 50_000, cloudJobsPerDay: 2 }
      }).limits
    ).toEqual({
      dailyRequests: 20,
      dailyTokens: 50_000,
      cloudJobsPerDay: 2
    })
  })

  it('meters usage against limits', () => {
    expect(meterAgainstLimit(10, null).exhausted).toBe(false)
    expect(meterAgainstLimit(75, 75).exhausted).toBe(true)
    expect(meterAgainstLimit(10, 75).remaining).toBe(65)
  })
})
