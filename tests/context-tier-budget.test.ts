import { describe, expect, it } from 'vitest'
import {
  AUTO_TIER_CEILING_MIB,
  automaticTierBudget,
  settleTierBudget,
  type TierHost
} from '../src/shared/context-tier-budget'
import { InferenceGovernor } from '../electron/main/services/inference-governor'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { ContextMemorySettingsSchema } from '../src/shared/context-memory'

const G = 1024 ** 3
const host = (over: Partial<TierHost>): TierHost => ({
  kind: 'dedicated',
  totalBytes: 64 * G,
  availableBytes: 48 * G,
  reserveBytes: 8 * G,
  modelBytes: 0,
  ...over
})

describe('automatic RAM tier budget', () => {
  it('stays under the V8 heap ceiling on a large dedicated-GPU host', () => {
    const budget = automaticTierBudget(host({}))
    expect(budget.memoryMiB).toBe(AUTO_TIER_CEILING_MIB)
    expect(budget.threadMiB).toBe(128)
    expect(budget.reason).toContain('dedicated GPU')
  })

  it('does not shrink a dedicated budget for VRAM-resident weights', () => {
    const small = host({ totalBytes: 32 * G, availableBytes: 7 * G, reserveBytes: 5 * G })
    expect(automaticTierBudget({ ...small, modelBytes: 24 * G }).memoryMiB).toBe(
      automaticTierBudget(small).memoryMiB
    )
  })

  it('puts the model first on unified memory', () => {
    const unified = host({
      kind: 'unified',
      totalBytes: 16 * G,
      availableBytes: 10 * G,
      reserveBytes: 2 * G
    })
    const idle = automaticTierBudget(unified)
    const loaded = automaticTierBudget({ ...unified, modelBytes: 13.5 * G })
    expect(idle.memoryMiB).toBe(128)
    expect(loaded.memoryMiB).toBeLessThan(idle.memoryMiB)
    expect(automaticTierBudget({ ...unified, modelBytes: 14 * G }).memoryMiB).toBe(0)
  })

  it('imposes no minimum when safe headroom is zero', () => {
    for (const kind of ['dedicated', 'unified', 'unknown'] as const) {
      const budget = automaticTierBudget(host({ kind, availableBytes: 2 * G }))
      expect(budget).toMatchObject({ memoryMiB: 0, threadMiB: 0 })
    }
  })

  it('treats an undetected GPU as shared memory and says so', () => {
    const budget = automaticTierBudget(host({ kind: 'unknown', totalBytes: 8 * G }))
    expect(budget.memoryMiB).toBeLessThanOrEqual(64)
    expect(budget.reason).toContain('not detected')
  })

  it('shrinks at once but grows only with margin', () => {
    const near = host({ totalBytes: 32 * G, availableBytes: 6.5 * G, reserveBytes: 5 * G })
    const settled = automaticTierBudget(near)
    const nudged = { ...near, availableBytes: near.availableBytes + 0.2 * G }
    expect(automaticTierBudget(nudged).memoryMiB).toBeGreaterThan(settled.memoryMiB)
    expect(settleTierBudget(settled, nudged).memoryMiB).toBe(settled.memoryMiB)
    const roomy = { ...near, availableBytes: 16 * G }
    expect(settleTierBudget(settled, roomy).memoryMiB).toBeGreaterThan(settled.memoryMiB)
    const tight = { ...near, availableBytes: 5.5 * G }
    expect(settleTierBudget(settled, tight).memoryMiB).toBeLessThan(settled.memoryMiB)
  })

  it('a zero budget holds nothing and stays usable when room returns', () => {
    const store = new ContextMemoryStore()
    const settings = ContextMemorySettingsSchema.parse({})
    store.configure({ ...settings, maxMemoryMiB: 0, maxThreadMiB: 0 })
    expect(store.reserve('tier:zero', 1024)).toBeNull()
    store.configure({ ...settings, maxMemoryMiB: 64, maxThreadMiB: 16 })
    const reservation = store.reserve('tier:zero', 1024)
    expect(reservation).not.toBeNull()
    reservation?.release()
  })

  it('still gives way to a model that needs the memory on a shared pool', () => {
    const governor = new InferenceGovernor(() => ({ total: 16 * G, free: 6 * G, reserve: 2 * G }))
    const store = new ContextMemoryStore()
    const budget = automaticTierBudget(
      host({ kind: 'unified', totalBytes: 16 * G, availableBytes: 6 * G, reserveBytes: 2 * G })
    )
    store.configure({
      ...ContextMemorySettingsSchema.parse({}),
      maxMemoryMiB: budget.memoryMiB,
      maxThreadMiB: budget.threadMiB
    })
    governor.registerOptionalMemory({
      ledger: () => store.ledger,
      limit: (bytes) => void store.setPressureLimit(bytes)
    })
    const held = store.reserve('tier:model', 32 * 1024 ** 2)
    expect(held).not.toBeNull()
    governor.refreshMemoryPressure(6 * G)
    expect(store.overEnvelopeBytes).toBeGreaterThan(0)
    held?.release()
  })
})
