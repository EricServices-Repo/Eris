export type DurableJournalTrust = 'local' | 'command' | 'untrusted'

/** One tool result kept past its run. Text is redacted before it reaches this type. */
export type DurableJournalEntry = {
  ref: string
  /** The user message that started the run. Its forget, cutoff and scope apply here. */
  sourceId: string
  runId: string
  seq: number
  toolName: string
  argsSummary: string
  trust: DurableJournalTrust
  bytes: number
  at: number
  projectRoot: string | null
  /** Null when only the metadata was kept; `omitted` then says why. */
  text: string | null
  omitted?: 'memory-pressure'
}
export type DurableJournalMeta = Omit<DurableJournalEntry, 'text' | 'omitted'> & {
  omitted: string | null
}
export type DurableJournalHit = { entry: DurableJournalMeta; score: number; snippet: string }
export type DurableJournalRead =
  | { status: 'found'; entry: DurableJournalMeta; text: string }
  | { status: 'omitted'; entry: DurableJournalMeta }
  | { status: 'unavailable' }
