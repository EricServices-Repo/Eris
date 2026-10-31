import { describe, expect, it } from 'vitest'
import { InferenceGovernor } from '../electron/main/services/inference-governor'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  DEDICATED_HOST_OVERHEAD_BYTES,
  GENERATION_SCRATCH_BYTES,
  textHostReservation,
  textModelPeakBytes
} from '../electron/main/services/vram-fit'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'

const G = 1024 ** 3
const KEY = 'thread'
type Host = { total: number; free: number; reserve: number; kind: 'unified' | 'dedicated' }

function rig(host: Host, messages = 50, size = 20) {
  const governor = new InferenceGovernor(() => ({
    total: host.total * G,
    free: host.free * G,
    reserve: host.reserve * G
  }))
  let tick = 0
  const store = new ContextMemoryStore(() => ++tick)
  store.configure(ContextMemorySettingsSchema.parse({}))
  governor.registerOptionalMemory({
    ledger: () => store.ledger,
    limit: (bytes) => void store.setPressureLimit(bytes)
  })
  governor.setDevices([
    {
      id: 'gpu',
      name: 'gpu',
      kind: host.kind,
      totalBytes: (host.kind === 'dedicated' ? 24 : host.total) * G,
      source: 'driver-reported'
    }
  ])
  store.install(
    KEY,
    {
      revision: 1,
      sourceEpoch: 'epoch',
      total: messages,
      records: Array.from({ length: messages }, (_, ordinal) => ({
        ordinal,
        message: {
          id: `m${ordinal}`,
          role: 'user' as const,
          content: `remember ${ordinal} `.padEnd(size, 'x'),
          createdAt: ordinal
        }
      })),
      controls: emptyMemoryControls(),
      partial: false
    },
    store.token(KEY)
  )
  return { governor, store }
}

/** The lease production code takes for a model that is already loaded. */
async function generate(rigged: ReturnType<typeof rig>, host: Host, modelGiB: number) {
  const peakBytes = textModelPeakBytes(modelGiB * G)
  const deviceBytes = host.kind === 'dedicated' ? Math.min(peakBytes, 0.8 * 24 * G) : 0
  const lease = await rigged.governor.acquire({
    workload: 'text',
    deviceId: 'gpu',
    deviceBytes,
    ...textHostReservation({ peakBytes, deviceBytes, loaded: true }),
    waitTimeoutMs: 5
  })
  const kept = rigged.store.has(KEY)
  lease.release()
  return { kept, pressure: rigged.governor.status().contextPressure?.pressure }
}

describe('text leases on a loaded model', () => {
  it.each([
    ['16 GiB unified, 4 GiB model', { total: 16, free: 6, reserve: 4, kind: 'unified' }, 4],
    ['32 GiB unified, 8 GiB model', { total: 32, free: 14, reserve: 8, kind: 'unified' }, 8],
    ['32 GiB host, 16 GiB in VRAM', { total: 32, free: 24, reserve: 4.8, kind: 'dedicated' }, 16],
    ['32 GiB host, 12 GiB in VRAM', { total: 32, free: 22, reserve: 4.8, kind: 'dedicated' }, 12],
    ['64 GiB host, 16 GiB in VRAM', { total: 64, free: 40, reserve: 9.6, kind: 'dedicated' }, 16]
  ] as Array<[string, Host, number]>)('keeps the store: %s', async (_, host, model) => {
    const result = await generate(rig(host), host, model)
    expect(result.kept).toBe(true)
    expect(result.pressure).toBe('normal')
  })
  it('does not count a resident model as pending', async () => {
    const governor = new InferenceGovernor(() => ({ total: 32 * G, free: 14 * G, reserve: 8 * G }))
    const lease = await governor.acquire({
      workload: 'text',
      gpu: false,
      requestedBytes: 11 * G,
      residentBytes: 11 * G - GENERATION_SCRATCH_BYTES
    })
    expect(governor.refreshMemoryPressure().pendingNativeBytes).toBe(GENERATION_SCRATCH_BYTES)
    lease.release()
  })
  it('still counts a resident model against total capacity', async () => {
    const governor = new InferenceGovernor(() => ({ total: 32 * G, free: 14 * G, reserve: 8 * G }))
    const lease = await governor.acquire({
      workload: 'text',
      gpu: false,
      requestedBytes: 20 * G,
      residentBytes: 20 * G
    })
    await expect(
      governor.acquire({
        workload: 'index',
        gpu: false,
        requestedBytes: 6 * G,
        waitTimeoutMs: 1
      })
    ).rejects.toThrow(/deadline/)
    lease.release()
  })
  it('rejects an invalid resident figure', async () => {
    const governor = new InferenceGovernor(() => ({ total: 32 * G, free: 14 * G, reserve: 8 * G }))
    await expect(
      governor.acquire({ workload: 'text', requestedBytes: G, residentBytes: Number.NaN })
    ).rejects.toThrow(/Invalid/)
  })
})

describe('host charge by placement', () => {
  const peakBytes = textModelPeakBytes(16 * G)
  it('keeps a model the dedicated GPU can hold off the host', () => {
    expect(textHostReservation({ peakBytes, deviceBytes: peakBytes, loaded: false })).toEqual({
      requestedBytes: DEDICATED_HOST_OVERHEAD_BYTES,
      residentBytes: 0
    })
  })
  it('charges a model that may spill to the CPU in full', () => {
    expect(
      textHostReservation({ peakBytes, deviceBytes: peakBytes - 1, loaded: false }).requestedBytes
    ).toBe(peakBytes)
  })
  it('charges a first load on unified memory in full', () => {
    expect(textHostReservation({ peakBytes, deviceBytes: 0, loaded: false })).toEqual({
      requestedBytes: peakBytes,
      residentBytes: 0
    })
  })
  it('leaves only scratch pending once loaded', () => {
    const { requestedBytes, residentBytes } = textHostReservation({
      peakBytes,
      deviceBytes: 0,
      loaded: true
    })
    expect(requestedBytes - residentBytes).toBe(GENERATION_SCRATCH_BYTES)
  })
})

describe('eviction for upcoming native work', () => {
  const host = { total: 32, free: 12, reserve: 8, kind: 'unified' as const }
  /** Owned bytes of the rigged thread, and a request that overshoots headroom by `over`. */
  const request = (headroom: number, over: number) => ({
    workload: 'text' as const,
    gpu: false,
    requestedBytes: Math.ceil(headroom + over),
    waitTimeoutMs: 5
  })
  it('frees the shortfall, not the whole store', async () => {
    const { governor, store } = rig(host, 2_000)
    const owned = store.ledger.ownedBytes
    const lease = await governor.acquire(request(4 * G, owned / 2))
    expect(store.has(KEY)).toBe(true)
    expect(store.ledger.ownedBytes).toBeLessThanOrEqual(owned / 2)
    expect(store.ledger.ownedBytes).toBeGreaterThan(owned * 0.45)
    lease.release()
  })
  it('gives up the oldest rows first', async () => {
    const { governor, store } = rig(host, 2_000)
    const before = store.ledger.ownedBytes
    const lease = await governor.acquire(request(4 * G, before / 2))
    const { inspection } = await store.select(KEY, 'remember')
    expect(inspection.manifest.firstOrdinal).toBeGreaterThan(0)
    expect(inspection.manifest.retainedMessages).toBeGreaterThan(0)
    expect(inspection.manifest.coverage).toBe('partial')
    lease.release()
  })
  it('evicts colder threads before touching the newest', async () => {
    const { governor, store } = rig(host, 500)
    const newestBytes = store.ledger.ownedBytes
    store.install(
      'cold',
      {
        revision: 1,
        sourceEpoch: 'cold',
        total: 1,
        records: [
          {
            ordinal: 0,
            message: { id: 'c', role: 'user', content: 'x'.repeat(4096), createdAt: 0 }
          }
        ],
        controls: emptyMemoryControls(),
        partial: false
      },
      store.token('cold')
    )
    const coldBytes = store.ledger.ownedBytes - newestBytes
    await store.select(KEY, 'remember')
    const lease = await governor.acquire(request(4 * G, coldBytes))
    expect(store.has('cold')).toBe(false)
    expect(store.has(KEY)).toBe(true)
    lease.release()
  })
  it('still empties the store when the host itself is out of memory', () => {
    const { governor, store } = rig({ ...host, free: 8 })
    expect(governor.refreshMemoryPressure().pressure).toBe('critical')
    expect(store.has(KEY)).toBe(false)
  })
  it('lets OS-confirmed critical pressure empty the store, even with work pending', async () => {
    const store = new ContextMemoryStore()
    let limit = -1
    const governor = new InferenceGovernor(() => ({
      total: 32 * G,
      free: 12 * G,
      reserve: 8 * G,
      osPressure: 'critical' as const
    }))
    governor.registerOptionalMemory({
      ledger: () => store.ledger,
      limit: (bytes) => {
        limit = bytes
      }
    })
    const lease = await governor.acquire(request(4 * G, G))
    expect(limit).toBe(0)
    lease.release()
  })
  it('reports what an eviction released', () => {
    const { store } = rig(host)
    const owned = store.ledger.ownedBytes
    expect(store.setPressureLimit(Infinity)).toBe(0)
    expect(store.setPressureLimit(0)).toBe(owned)
  })
})
