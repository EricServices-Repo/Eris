export const THREAD_SUMMARY_VERSION = 1
/** The ref a model reads the summary with. It never collides with a hex or `t…` ref. */
export const THREAD_SUMMARY_REF = 'thread-summary'

export type ThreadSummaryItem = {
  kind: 'decision' | 'constraint' | 'unfinished'
  sourceId: string
  ordinal: number
  text: string
  /** Earlier decisions on the same subject this one replaced. */
  corrects?: number
  /** A task's recorded end state, so failed and stopped work stay distinguishable. */
  terminal?: string
}

/** Rebuilt from canonical rows on every read, so nothing can go stale behind a source. */
export type ThreadSummary = {
  version: typeof THREAD_SUMMARY_VERSION
  kind: 'deterministic'
  digest: string
  scope: {
    threadId: string
    projectRoot?: string | null
    revision: number
    controlsRevision: number
    sourceEpoch: string
  }
  coverage: {
    totalMessages: number
    scannedMessages: number
    excludedMessages: number
    corruptMessages: number
    /** False when the scan limits stopped before the oldest message. */
    complete: boolean
  }
  /** Items that matched but did not fit, by kind. */
  omitted: Record<ThreadSummaryItem['kind'], number>
  items: ThreadSummaryItem[]
}

const HEADINGS: Array<[ThreadSummaryItem['kind'], string]> = [
  ['unfinished', 'Unfinished work'],
  ['decision', 'Decisions'],
  ['constraint', 'Stated constraints']
]

/** Everything here cites a message, and none of it is verified against the current files. */
export function threadSummaryText(summary: ThreadSummary) {
  const { coverage, omitted } = summary
  const dropped = Object.values(omitted).reduce((sum, count) => sum + count, 0)
  const lines = [
    `Thread summary v${summary.version} · deterministic · ${summary.digest.slice(0, 12)} · ` +
      `${coverage.scannedMessages} of ${coverage.totalMessages} messages read` +
      `${coverage.complete ? '' : ' (older messages not read)'} · ` +
      `${coverage.excludedMessages} excluded · ${coverage.corruptMessages} unreadable · ` +
      `${dropped} items over the limit`
  ]
  for (const [kind, heading] of HEADINGS) {
    const items = summary.items.filter((item) => item.kind === kind)
    if (!items.length) continue
    lines.push(heading)
    for (const item of items) {
      const notes = [
        item.terminal ? `ended ${item.terminal}` : '',
        item.corrects ? `replaces ${item.corrects} earlier` : ''
      ].filter(Boolean)
      lines.push(
        `- [message ${item.ordinal}] ${item.text}${notes.length ? ` (${notes.join(', ')})` : ''}`
      )
    }
  }
  if (lines.length === 1) lines.push('Nothing recorded yet.')
  return lines.join('\n')
}
