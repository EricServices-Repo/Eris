import type { ContextMemorySettings } from './context-memory'
export type ArchiveMemoryUsage = {
  initialized: boolean
  conversations: number
  messages: number
  databaseBytes: number
  journalBytes: number
}
export type MemoryUsageStatus = {
  tiers?: {
    model: null | {
      ref: string
      contextSize: number
      gpuLayers?: number
      totalLayers?: number
      kvBytes?: number
      device?: string
    }
    devices: import('./inference').InferenceSnapshot['devices']
    pressure: 'normal' | 'constrained' | 'critical'
    budgetReason: string
    pressureReason: string
    journal: { bytes: number; searches: number; evicted: number; runs: number }
    lastDispatch: null | {
      model: string
      counts: import('./context-memory').ContextBundleCounts
      window?: number
    }
  }
  at: number
  scope: 'workspace' | 'profile'
  config: ContextMemorySettings
  projectMemory: 'auto' | 'ask' | 'off'
  effectivePolicy: ContextMemorySettings
  cache: {
    ownedBytes: number
    reservedBytes: number
    pinnedBytes: number
    envelopeBytes: number
    activeBytes: number
    historicalBytes: number
    warmConversations: number
  }
  rendererHistoryBytes: number
  process: { rss: number; heapUsed: number }
  archive: ArchiveMemoryUsage | null
  archiveError: string | null
}

/** Unknown/remote residency must never be described as full GPU offload. */
export function modelOffloadLabel(model: NonNullable<MemoryUsageStatus['tiers']>['model']): string {
  if (!model) return 'No native model loaded'
  if (model.gpuLayers === undefined || model.totalLayers === undefined || model.totalLayers <= 0)
    return 'GPU placement unavailable'
  return model.gpuLayers >= model.totalLayers
    ? 'Fully on GPU'
    : model.gpuLayers === 0
      ? 'CPU execution'
      : 'Partially on GPU'
}
