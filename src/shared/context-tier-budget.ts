/** Auto stays here until #228 moves the store off the main-process V8 heap. */
export const AUTO_TIER_CEILING_MIB = 512
const MIB = 1024 ** 2
const STEP_MIB = 16
const MAX_AUTO_THREAD_MIB = 128
/** First estimates to benchmark, not measured targets. */
const DEDICATED_SHARE = 0.25
const UNIFIED_SHARE = 0.1
/** A rise must also hold with this much less memory, so a noisy sample cannot flap the budget. */
const GROWTH_MARGIN = 0.8
const UNIFIED_PROFILE_MIB: ReadonlyArray<readonly [number, number]> = [
  [64, 512],
  [32, 256],
  [16, 128],
  [0, 64]
]

export type TierHostClass = 'dedicated' | 'unified' | 'unknown'
export type TierHost = {
  kind: TierHostClass
  totalBytes: number
  /** Measured, reclaimable-aware free host memory. */
  availableBytes: number
  /** Host memory held back from optional use. */
  reserveBytes: number
  /** Peak of admitted model work; on unified memory this shares the pool with the tier. */
  modelBytes: number
}
export type ContextTierBudget = {
  mode: 'auto' | 'manual'
  memoryMiB: number
  threadMiB: number
  reason: string
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
const steps = (miB: number) => Math.floor(miB / STEP_MIB) * STEP_MIB

function sized(mode: 'auto', memoryMiB: number, reason: string): ContextTierBudget {
  const memory = steps(Math.max(0, memoryMiB))
  return {
    mode,
    memoryMiB: memory,
    threadMiB: Math.min(MAX_AUTO_THREAD_MIB, steps(memory / 4)),
    reason
  }
}

/** Zero is a valid answer: no minimum is imposed when safe headroom is gone (§7.2). */
export function automaticTierBudget(host: TierHost): ContextTierBudget {
  const free = Math.max(0, host.availableBytes - host.reserveBytes)
  if (host.kind === 'dedicated') {
    // VRAM-resident weights take nothing from host RAM, so they are not subtracted.
    const share = Math.min(AUTO_TIER_CEILING_MIB, (free * DEDICATED_SHARE) / MIB)
    return sized(
      'auto',
      share,
      `Automatic · dedicated GPU: ${DEDICATED_SHARE * 100}% of ${gib(free)} free host RAM, up to ${AUTO_TIER_CEILING_MIB} MiB.`
    )
  }
  const afterModel = Math.max(0, host.totalBytes - host.reserveBytes - host.modelBytes)
  const room = Math.min(free, afterModel)
  const profile = UNIFIED_PROFILE_MIB.find(([gigs]) => host.totalBytes >= gigs * 1024 ** 3)![1]
  const share = Math.min(profile, (room * UNIFIED_SHARE) / MIB)
  return sized(
    'auto',
    share,
    `Automatic · ${host.kind === 'unified' ? 'shared memory' : 'GPU not detected yet, treated as shared memory'}: ` +
      `model first, then ${UNIFIED_SHARE * 100}% of the ${gib(room)} left, up to ${profile} MiB.`
  )
}

/**
 * Shrinks at once and grows only with margin. The budget invalidates selections when it
 * changes, and second-to-second headroom is already handled by the pressure limit.
 */
export function settleTierBudget(previous: ContextTierBudget | undefined, host: TierHost) {
  const next = automaticTierBudget(host)
  if (!previous || next.memoryMiB <= previous.memoryMiB) return next
  const margin = automaticTierBudget({
    ...host,
    availableBytes: host.availableBytes * GROWTH_MARGIN
  })
  return margin.memoryMiB > previous.memoryMiB
    ? next
    : { ...next, memoryMiB: previous.memoryMiB, threadMiB: previous.threadMiB }
}
