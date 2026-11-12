import { describe, expect, it } from 'vitest'
import { idleWarmDecision } from '../electron/main/services/warm-policy'

describe('idle warm policy (#522)', () => {
  const base = { residentPath: 'a', targetPath: 'b', residentRequestedContext: 4096, targetRequestedContext: 4096, residentUsedByChatMsAgo: 60_000 }
  it('protects a recently used different resident', () => expect(idleWarmDecision(base)).toBe('skip-recently-used-model-resident'))
  it('allows a different model after the window', () => expect(idleWarmDecision({ ...base, residentUsedByChatMsAgo: 11 * 60_000 })).toBe('load'))
  it('recognizes the same model and context', () => expect(idleWarmDecision({ ...base, targetPath: 'a' })).toBe('already-warm'))
  it('loads the same model with a different context', () => expect(idleWarmDecision({ ...base, targetPath: 'a', targetRequestedContext: 8192 })).toBe('load'))
  it('loads when nothing is resident', () => expect(idleWarmDecision({ ...base, residentPath: null })).toBe('load'))
})
