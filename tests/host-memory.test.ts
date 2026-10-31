import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  availableBytesFromVmStat,
  currentHostMemory,
  osPressureFromLevel,
  recordHostMemorySample,
  sampleMacHostMemory,
  startHostMemorySampling
} from '../electron/main/services/host-memory'
import { InferenceGovernor } from '../electron/main/services/inference-governor'

const G = 1024 ** 3
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    88765.
Pages active:                                 321326.
Pages inactive:                               316048.
Pages speculative:                             25275.
Pages throttled:                                   0.
Pages wired down:                             175568.
Pages purgeable:                                7773.
`
const macHost = (free: number, osPressure?: 'normal' | 'warn' | 'critical') => () => ({
  total: 16 * G,
  free: free * G,
  reserve: 4 * G,
  pressureReserve: 2 * G,
  osPressure,
  source: 'macos-vm-counters' as const
})
const pressure = (memory: ReturnType<typeof macHost>) => {
  const governor = new InferenceGovernor(memory)
  let limit = -1
  governor.registerOptionalMemory({
    ledger: () => ({ ownedBytes: 0, reservedBytes: 0, pinnedBytes: 0 }),
    limit: (bytes) => {
      limit = bytes
    }
  })
  return { state: governor.refreshMemoryPressure().pressure, limit, status: governor.status() }
}

afterEach(() => recordHostMemorySample(null))

describe('macOS host memory', () => {
  it('counts the pages macOS reclaims on demand, not only free pages', () => {
    expect(availableBytesFromVmStat(VM_STAT)).toBe((88765 + 316048 + 25275 + 7773) * 16384)
  })
  it('refuses an unrecognised vm_stat rather than guessing a number', () => {
    expect(availableBytesFromVmStat('')).toBeNull()
    expect(availableBytesFromVmStat(VM_STAT.replace('Pages inactive', 'Pages idle'))).toBeNull()
  })
  it('maps the kernel pressure levels and ignores unknown ones', () => {
    expect(['1\n', '2\n', '4\n', '3\n', ''].map(osPressureFromLevel)).toEqual([
      'normal',
      'warn',
      'critical',
      undefined,
      undefined
    ])
  })
  it('keeps measuring when only the pressure level is unreadable', async () => {
    const sample = await sampleMacHostMemory(async (file) => {
      if (file.endsWith('vm_stat')) return VM_STAT
      throw new Error('sysctl unavailable')
    })
    expect(sample).toMatchObject({ source: 'macos-vm-counters' })
    expect(sample?.osPressure).toBeUndefined()
  })
  it('reports no sample when the counters are unreadable', async () => {
    await expect(sampleMacHostMemory(async () => 'nonsense')).resolves.toBeNull()
  })
})

describe('host memory readings', () => {
  const sample = {
    total: 16 * G,
    available: 7 * G,
    source: 'macos-vm-counters' as const,
    osPressure: 'normal' as const
  }
  it('uses plain OS-available memory until a sample exists', () => {
    expect(currentHostMemory()).toMatchObject({ source: 'system-free' })
  })
  it('stops trusting a sample the sampler no longer refreshes', () => {
    recordHostMemorySample(sample, 1_000)
    expect(currentHostMemory(1_000 + 20_000).source).toBe('macos-vm-counters')
    expect(currentHostMemory(1_000 + 20_001).source).toBe('system-free')
  })
  it('samples only where the free-memory figure needs correcting, and never overlaps', async () => {
    const platform = vi.spyOn(process, 'platform', 'get')
    platform.mockReturnValue('win32')
    const unused = vi.fn(async () => sample)
    startHostMemorySampling(() => {}, unused)()
    expect(unused).not.toHaveBeenCalled()

    platform.mockReturnValue('darwin')
    vi.useFakeTimers()
    try {
      let finish = (_: typeof sample) => {}
      const slow = vi.fn(() => new Promise<typeof sample>((resolve) => (finish = resolve)))
      const onSample = vi.fn()
      const stop = startHostMemorySampling(onSample, slow)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(slow).toHaveBeenCalledTimes(1)
      finish(sample)
      await vi.advanceTimersByTimeAsync(0)
      expect(onSample).toHaveBeenCalledTimes(1)
      expect(currentHostMemory().source).toBe('macos-vm-counters')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('inference pressure on macOS', () => {
  it('stays healthy on the reading that used to report critical pressure', () => {
    const { state, limit } = pressure(macHost(7, 'normal'))
    expect(state).toBe('normal')
    expect(limit).toBeGreaterThan(512 * 1024 ** 2)
  })
  it('never reports critical from arithmetic while the OS reports normal and nothing is pending', () => {
    expect(pressure(macHost(1.5, 'normal')).state).toBe('constrained')
  })
  it('follows OS warn and critical levels regardless of the counters', () => {
    expect(pressure(macHost(12, 'warn')).state).toBe('constrained')
    const critical = pressure(macHost(12, 'critical'))
    expect(critical.state).toBe('critical')
    expect(critical.limit).toBe(0)
  })
  it('keeps the arithmetic where the OS gives no signal', () => {
    expect(pressure(macHost(1.5)).state).toBe('critical')
  })
  it('exposes where the reading came from', () => {
    expect(pressure(macHost(7, 'normal')).status.memory).toMatchObject({
      source: 'macos-vm-counters',
      osPressure: 'normal'
    })
  })
})
