import {
  settleTierBudget,
  type ContextTierBudget,
  type TierHostClass
} from '../../../src/shared/context-tier-budget'
import {
  CONTEXT_THREAD_MAX_MIB,
  type ContextMemorySettings
} from '../../../src/shared/context-memory'
import { contextMemoryStore } from './context-memory-store'
import { inferenceGovernorStatus } from './inference-governor'
import { getResolvedSettings } from './settings'

let settled: ContextTierBudget | undefined

/**
 * Whether model memory competes with the RAM tier. A loaded model decides it by the
 * device it actually holds. Without one, any shared-memory device counts, because the
 * next model may land there: an Intel iGPU beside an RTX card stays conservative until
 * the RTX card is the one in use. A lease on a device discovery did not report is
 * treated the same way.
 */
export function hostClass(
  devices: ReadonlyArray<{ id: string; kind: 'unified' | 'dedicated' }>,
  active: ReadonlyArray<{ gpu: boolean; deviceId: string | null }> = []
): TierHostClass {
  if (!devices.length) return 'unknown'
  const held = active.filter((lease) => lease.gpu && lease.deviceId)
  const inUse = held.length
    ? held.map((lease) => devices.find((device) => device.id === lease.deviceId))
    : devices
  return inUse.every((device) => device?.kind === 'dedicated') ? 'dedicated' : 'unified'
}

/** The allocator's limits for this profile, with the reason Settings shows for them. */
export function resolveTierPolicy(policy: ContextMemorySettings): {
  policy: ContextMemorySettings
  budget: ContextTierBudget
} {
  if (policy.mode !== 'auto') {
    settled = undefined
    return {
      policy,
      budget: {
        mode: 'manual',
        memoryMiB: policy.maxMemoryMiB,
        threadMiB: policy.maxThreadMiB,
        reason: 'Manual budget, reduced by renderer history and current system memory headroom.'
      }
    }
  }
  const { memory, devices, active } = inferenceGovernorStatus()
  settled = settleTierBudget(settled, {
    kind: hostClass(devices, active),
    totalBytes: memory.total,
    availableBytes: memory.free,
    reserveBytes: memory.pressureReserve ?? memory.reserve,
    modelBytes: active.reduce((sum, lease) => sum + lease.reservedBytes, 0)
  })
  return {
    policy: { ...policy, maxMemoryMiB: settled.memoryMiB, maxThreadMiB: settled.threadMiB },
    budget: settled
  }
}

/** Only profile settings govern the process allocator; a workspace can never reconfigure it. */
export function configureContextTier() {
  const resolved = resolveTierPolicy(getResolvedSettings(null).agent.contextMemory)
  contextMemoryStore.configure(resolved.policy)
  return resolved.budget
}

/** An automatic policy sets no per-thread limit of its own: the profile's budget decides. */
export const namespaceThreadMiB = (policy: ContextMemorySettings) =>
  policy.mode === 'auto' ? CONTEXT_THREAD_MAX_MIB : policy.maxThreadMiB
