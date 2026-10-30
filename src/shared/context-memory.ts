import { z } from 'zod'
export const ContextMemorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxMemoryMiB: z.number().int().min(16).max(512).default(128),
  maxThreadMiB: z.number().int().min(4).max(128).default(32),
  maxMessages: z.number().int().min(500).max(100000).default(25000),
  warmThreads: z.number().int().min(1).max(16).default(8),
  idleMinutes: z.number().int().min(1).max(120).default(30),
  foregroundDeadlineMs: z.number().int().min(25).max(2000).default(150),
  promptTokens: z.number().int().min(128).max(4096).default(1024),
  shareWithRemoteModels: z.boolean().default(false)
})
export type ContextMemorySettings = z.infer<typeof ContextMemorySettingsSchema>
export type MemoryFact = {
  id: string
  sourceId: string
  ordinal: number
  kind: 'user-stated' | 'prior-answer' | 'recommendation' | 'task-result' | 'pinned' | 'decision'
  text: string
  status: 'user-stated' | 'unverified' | 'observed' | 'active' | 'disputed'
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
  /** Lexical ranking that produced this selection. */
  rankingVersion?: number
  /** Matching raw sources already covered by admitted complete recent turns. */
  duplicateSourceMessages?: number
  /** Character estimate of avoided candidate text, not measured backend tokens. */
  duplicateEstimatedTokensAvoided?: number
  corruptRecords?: number
  corruptOrdinals?: number[]
  omittedFacts: number
  omittedPinnedFacts?: number
  reason?: string
}
/** One recalled unit exactly as rendered into a prompt, so it can be traced or removed later. */
export type MemoryPromptItem = {
  dependencies?: import('./context-evidence').ContextEvidence
  id: string
  sourceId: string
  kind: MemoryFact['kind']
  ordinal: number
  /** Unicode-unit position of the excerpt in its source message. Absent for pins and receipts. */
  span?: { offset: number; length: number }
  text: string
  line: string
}
/** The identifying prefix of a rendered item; it is unique to the item's source and kind. */
export const memoryItemMarker = (line: string) => line.slice(0, line.indexOf('] ') + 2)
export type ContextItemStatus = 'sent' | 'truncated' | 'omitted'
export type ContextItemReason =
  | 'fits-budget'
  | 'input-budget'
  | 'duplicate-evidence'
  | 'destination-policy'
  | 'provider-budget'
  | 'revoked-at-dispatch'
/** Digests and positions only: this record is logged, so it never carries source text. */
export type ContextBundleItem = {
  id: string
  sourceDigest: string
  kind: MemoryFact['kind']
  ordinal: number
  span?: { offset: number; length: number }
  digest: string
  chars: number
  sentChars: number
  status: ContextItemStatus
  reason: ContextItemReason
}
export type ContextBundleCounts = Record<ContextItemStatus, number> & { selected: number }
export type ContextBundle = {
  version: 1
  taskId: string
  /** Memory namespace, so a later inspection can find its conversation's last request. */
  namespace?: string
  tokenizer: {
    method: 'characters'
    tokenizer: 'none'
    charsPerToken: number
    nonAsciiCharsPerToken: number
  }
  counts: ContextBundleCounts
  items: ContextBundleItem[]
}
/** What one model request actually carried, measured after provider adaptation. */
export type ContextDispatch = {
  version: 1
  taskId: string
  model: string
  destination: 'local' | 'remote'
  /** False when a diagnostics adapter received the request before provider adaptation. */
  adapted: boolean
  requestDigest: string
  /** Conservative estimate for the whole request; never a provider measurement. */
  estimatedTokens: number
  counts: ContextBundleCounts
  /** Present on a run's first dispatch and whenever an item's status changes. */
  items?: ContextBundleItem[]
  at: number
}
export type MemoryPrompt = {
  text: string
  manifest: MemoryManifest
  allowRemote: boolean
  /** Namespace this prompt was selected from. */
  namespace?: string
  items?: MemoryPromptItem[]
  /** Revocation state at selection; dispatch compares it before sending these items. */
  evidenceToken?: string
}
export type MemoryInspection = {
  /** Opaque main-owned handle binding controls to the inspected namespace and source. */
  snapshotHandle?: string
  /** True only when controls were read from the durable source for this inspection. */
  controlsAvailable?: boolean
  manifest: MemoryManifest
  facts: MemoryFact[]
  controls: MemoryControls
  processLogicalBytes: number
  /** Estimated bytes by owner against one envelope; separate from process heap or RSS. */
  ledger?: {
    ownedBytes: number
    reservedBytes: number
    pinnedBytes: number
    envelopeBytes: number
  }
  /** The latest actual model request for this conversation, when one ran this session. */
  lastDispatch?: ContextDispatch
  /** Task scope recall used; undefined until a turn in this session has resolved one. */
  projectRoot?: string | null
  /** The shared compiler's decision for each fact at the selected destination. */
  preview?: ContextPreview
}
export type ContextPreview = {
  model: string
  destination: 'local' | 'remote'
  counts: ContextBundleCounts
  items: Array<Pick<ContextBundleItem, 'id' | 'status' | 'reason'>>
}
export type ContextHeader = { revision: number; messageCount: number; sourceEpoch: string }
export type ContextPage = {
  sourceEpoch?: string
  revision: number
  messageCount: number
  before: number
  /** Continue the same ordinal before this Unicode code-point offset. */
  beforeContentOffset?: number
  metadataOmitted?: number
  done: boolean
  records: Array<{
    ordinal: number
    message: import('./settings-schema').ChatMessage
    /** Normalized recall terms, prepared in the worker so main never tokenizes a page. */
    terms?: string[]
  }>
  omitted: number
  corruptRecords?: number
  corruptOrdinals?: number[]
}
