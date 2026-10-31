import { describe, expect, it, vi } from 'vitest'

// tests/setup.ts stubs host memory, which is how #215 went unseen. This file must not.
vi.unmock('os')

import { freemem, totalmem } from 'os'
import { sampleMacHostMemory } from '../electron/main/services/host-memory'

describe('host memory on this real machine', () => {
  it('reads the operating system, not the test stub', () => {
    expect(totalmem()).toBeGreaterThan(0)
    expect(freemem()).toBeLessThanOrEqual(totalmem())
    expect([totalmem(), freemem()]).not.toEqual([32 * 1024 ** 3, 24 * 1024 ** 3])
  })

  it.runIf(process.platform === 'darwin')(
    'counts reclaimable pages and reads the OS pressure level',
    async () => {
      const sample = await sampleMacHostMemory()
      expect(sample).not.toBeNull()
      expect(sample!.source).toBe('macos-vm-counters')
      expect(sample!.available).toBeGreaterThan(0)
      expect(sample!.available).toBeLessThanOrEqual(totalmem())
      // Reclaimable memory is the #215 fix: it must not collapse to raw free pages.
      expect(sample!.available).toBeGreaterThanOrEqual(freemem())
      expect(['normal', 'warn', 'critical', undefined]).toContain(sample!.osPressure)
    }
  )
})
