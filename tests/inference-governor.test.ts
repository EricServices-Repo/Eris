import { afterEach, describe, it, expect, vi } from 'vitest'
import { InferenceGovernor } from '../electron/main/services/inference-governor'
afterEach(() => vi.useRealTimers())
const request = (workload: 'text' | 'image' | 'index', requestedBytes: number) => ({
  workload,
  requestedBytes,
  owner: workload,
  gpu: workload !== 'index'
})
describe('main-process inference accounting', () => {
  it('does not pool two dedicated devices, and exposes estimates separately from measurements', async () => {
    const g = new InferenceGovernor(() => ({ total: 100, free: 100, reserve: 0 }))
    g.setDevices([
      {
        id: 'cuda:0',
        name: '4060',
        kind: 'dedicated',
        totalBytes: 8,
        freeBytes: 6,
        source: 'driver-reported'
      },
      {
        id: 'cuda:1',
        name: '5050',
        kind: 'dedicated',
        totalBytes: 8,
        freeBytes: 7,
        source: 'driver-reported'
      }
    ])
    await expect(
      g.acquire({ ...request('text', 10), deviceId: 'cuda:0', deviceBytes: 14 })
    ).rejects.toThrow(/not pooled/)
    const lease = await g.acquire({ ...request('text', 10), deviceId: 'cuda:0', deviceBytes: 6 })
    expect(g.status().active[0].deviceBytes).toBe(6)
    expect(g.status().devices[0].freeBytes).toBe(6)
    lease.release()
    lease.release()
    expect(g.status().active).toHaveLength(0)
  })
  it('uses an aged FIFO reservation barrier to prevent continuous small jobs starving an image', async () => {
    vi.useFakeTimers()
    let time = 0
    const g = new InferenceGovernor(
      () => ({ total: 100, free: 100, reserve: 0 }),
      () => time
    )
    const active = await g.acquire({ ...request('index', 60), gpu: false })
    const image = g.acquire({ ...request('image', 80), gpu: false }),
      admissions: string[] = []
    void image.then(() => admissions.push('image'))
    time = 3000
    g.drain()
    const small = g.acquire({ ...request('index', 30), priority: 100 })
    void small.then(() => admissions.push('small'))
    expect(g.status().queued.map((r) => r.owner)).toEqual(['image', 'index'])
    active.release()
    const lease = await image
    await Promise.resolve()
    expect(admissions).toEqual(['image'])
    lease.release()
    ;(await small).release()
  })
  it('cancels only the queued owner and preserves active work until its cleanup releases', async () => {
    const g = new InferenceGovernor(() => ({ total: 100, free: 100, reserve: 0 })),
      active = await g.acquire(request('text', 10)),
      controller = new AbortController()
    const cancelled = g.acquire({ ...request('image', 20), signal: controller.signal }),
      assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
    expect(g.status().active[0].id).toBe(active.id)
    expect(g.status().queued).toHaveLength(0)
    active.release()
    expect(g.status().incidents.some((r) => r.kind === 'cancelled')).toBe(true)
  })
  it('expires waits with an actionable origin and removes their listeners/reservations', async () => {
    vi.useFakeTimers()
    let time = 0
    const g = new InferenceGovernor(
        () => ({ total: 100, free: 100, reserve: 0 }),
        () => time
      ),
      active = await g.acquire(request('text', 10))
    const waiting = g.acquire({ ...request('image', 20), waitTimeoutMs: 100 }),
      assertion = expect(waiting).rejects.toMatchObject({ code: 'INFERENCE_QUEUE_TIMEOUT' })
    time = 101
    g.drain()
    await assertion
    expect(g.status().queued).toHaveLength(0)
    expect(g.status().incidents.at(-1)?.reason).toContain('GPU owner')
    active.release()
  })
  it('keeps unified memory in the host ledger and rejects invalid or pre-cancelled admission', async () => {
    const g = new InferenceGovernor(() => ({ total: 100, free: 100, reserve: 10 }))
    g.setDevices([
      { id: 'metal:0', name: 'M4', kind: 'unified', totalBytes: 100, source: 'system-reported' }
    ])
    const lease = await g.acquire({ ...request('image', 70), deviceId: 'metal:0', deviceBytes: 0 })
    expect(g.status().active[0].reservedBytes).toBe(70)
    lease.release()
    await expect(g.acquire(request('text', NaN))).rejects.toThrow(/Invalid/)
    const c = new AbortController()
    c.abort()
    await expect(g.acquire({ ...request('text', 1), signal: c.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe('RAM-CTX-020 shared host pressure', () => {
  it('releases optional history before admitting foreground memory and never forces a minimum at zero headroom', async () => {
    let free = 90,
      ownedBytes = 40
    const g = new InferenceGovernor(() => ({ total: 100, free, reserve: 10 }))
    const limits: number[] = []
    g.registerOptionalMemory({
      ledger: () => ({ ownedBytes, reservedBytes: 0, pinnedBytes: 0 }),
      limit: (n) => {
        limits.push(n)
        ownedBytes = Math.min(ownedBytes, n)
      }
    })
    const lease = await g.acquire({ ...request('text', 75), gpu: false })
    expect(ownedBytes).toBeLessThanOrEqual(15)
    free = 10
    expect(g.refreshMemoryPressure().pressure).toBe('critical')
    expect(limits.at(-1)).toBe(0)
    expect(ownedBytes).toBe(0)
    lease.release()
  })
  it('distinguishes pending peaks from confirmed materialized bytes and uses hysteresis', async () => {
    let free = 100
    const g = new InferenceGovernor(() => ({ total: 100, free, reserve: 10 }))
    const lease = await g.acquire({ ...request('text', 60), gpu: false })
    expect(g.refreshMemoryPressure().pendingNativeBytes).toBe(60)
    free = 40 // allocation is now represented in OS free memory
    lease.markMaterialized()
    expect(g.refreshMemoryPressure()).toMatchObject({
      pendingNativeBytes: 0,
      materializedNativeBytes: 60,
      pressure: 'normal'
    })
    free = 10
    expect(g.refreshMemoryPressure().pressure).toBe('critical')
    free = 11
    expect(g.refreshMemoryPressure().pressure).toBe('critical')
    free = 16
    expect(g.refreshMemoryPressure().pressure).toBe('constrained')
    free = 19
    expect(g.refreshMemoryPressure().pressure).toBe('normal')
    lease.release()
  })
})
