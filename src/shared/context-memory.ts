import { z } from 'zod'
export const ContextMemorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxMemoryMiB: z.number().int().min(16).max(512).default(128),
  maxThreadMiB: z.number().int().min(4).max(128).default(32),
  maxMessages: z.number().int().min(500).max(100000).default(25000),
  warmThreads: z.number().int().min(1).max(16).default(8),
  idleMinutes: z.number().int().min(1).max(120).default(30),
  promptTokens: z.number().int().min(128).max(4096).default(1024),
  shareWithRemoteModels: z.boolean().default(false)
})
export type ContextMemorySettings = z.infer<typeof ContextMemorySettingsSchema>
export type MemoryFact = {
  id: string
  sourceId: string
  ordinal: number
  kind: 'user-stated' | 'prior-answer' | 'recommendation' | 'task-result' | 'pinned'
  text: string
  status: 'user-stated' | 'unverified' | 'observed'
  projectRoot?: string | null
}
export const CONTEXT_CONTROLS_CONFLICT = 'CONTEXT_CONTROLS_CONFLICT' as const
export const MemoryControlsSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().optional(),
    forgotten: z.array(z.string().min(1).max(256)).max(10000),
    pinned: z
      .array(
        z.object({ id: z.string().min(1).max(256), text: z.string().min(1).max(2000) }).strict()
      )
      .max(100),
    afterOrdinal: z.number().int().nonnegative(),
    afterSequence: z.number().int().nonnegative().optional()
  })
  .strict()
  .refine(
    (value) => {
      const content = { ...value } as Record<string, unknown>
      delete content.afterSequence
      delete content.revision
      return new TextEncoder().encode(JSON.stringify(content)).byteLength <= 750000
    },
    {
      message: 'Recall controls exceed 750 KB; remove unused exclusions or pins.'
    }
  )
export type MemoryControls = z.infer<typeof MemoryControlsSchema>
export const emptyMemoryControls = (): MemoryControls => ({
  version: 1,
  forgotten: [],
  pinned: [],
  afterOrdinal: 0
})
export type MemoryManifest = {
  version: 1
  revision: number
  generation: number
  totalMessages: number
  retainedMessages: number
  firstOrdinal: number
  logicalBytes: number
  coverage: 'complete' | 'partial' | 'disabled' | 'unavailable'
  selectedIds: string[]
  sourceIds: string[]
  estimatedTokens: number
  omittedFacts: number
  omittedPinnedFacts?: number
  reason?: string
}
export type MemoryPrompt = { text: string; manifest: MemoryManifest; allowRemote: boolean }
export type MemoryInspection = {
  /** True only when controls were read from the durable source for this inspection. */
  controlsAvailable?: boolean
  manifest: MemoryManifest
  facts: MemoryFact[]
  controls: MemoryControls
  processLogicalBytes: number
}
export type ContextHeader = { revision: number; messageCount: number; sourceEpoch: string }
export type ContextPage = {
  sourceEpoch?: string
  revision: number
  messageCount: number
  before: number
  done: boolean
  records: Array<{ ordinal: number; message: import('./settings-schema').ChatMessage }>
  omitted: number
}
