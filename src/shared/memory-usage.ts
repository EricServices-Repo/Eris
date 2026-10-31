import type { ContextMemorySettings } from './context-memory'
export type ArchiveMemoryUsage = {
  initialized: boolean
  conversations: number
  messages: number
  databaseBytes: number
  journalBytes: number
}
export type MemoryUsageStatus = {
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
  process: { rss: number; heapUsed: number }
  archive: ArchiveMemoryUsage | null
  archiveError: string | null
}
