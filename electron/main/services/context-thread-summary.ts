import { createHash } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryControls } from '../../../src/shared/context-memory'
import { contextRecord } from '../../../src/shared/context-record'
import type { ChatMessage } from '../../../src/shared/settings-schema'
import {
  THREAD_SUMMARY_VERSION,
  type ThreadSummary,
  type ThreadSummaryItem
} from '../../../src/shared/thread-summary'
import { declaredDecisions } from './context-decisions'
import { recallExcluded } from './context-memory-store'

const MAX_SCANNED_ROWS = 20_000
const MAX_SCANNED_BYTES = 64 * 1024 ** 2
/**
 * The caller stops waiting after 2 s, but the worker would keep scanning and hold up every
 * request queued behind it. Stop well inside that and report the scan as incomplete.
 */
const MAX_SCAN_MS = 1500
const MAX_ITEM_CHARS = 240
const LIMITS: Record<ThreadSummaryItem['kind'], number> = {
  decision: 24,
  constraint: 16,
  unfinished: 16
}
const DONE = /^(?:done|complete)$/
/**
 * A user's own imperative. Assistant text can never produce one of these. A list marker or a
 * short lead-in ("please", "important:") may come first, as users write rules in lists.
 */
const CONSTRAINT =
  /^\s*(?:(?:[-*•]|\d{1,3}[.)])\s+)?(?:(?:please|also|and|important|note)\b[\s,:-]*)?(?:remember\b|always\b|never\b|do not\b|don['’]t\b|must\b)/iu

const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS)

type Header = { revision: number; sourceEpoch: string }

function unfinishedText(message: ChatMessage) {
  const state = message.contextResult?.workingState
  if (!state || DONE.test(state.terminal)) return null
  const pending = state.obligations.filter((item) => item.state === 'pending')
  const open = state.questions.filter((item) => !item.answered)
  return {
    taskId: state.taskId,
    terminal: state.terminal,
    text: clip(
      [...pending.map((item) => item.text), ...open.map((item) => `Open: ${item.text}`)].join(
        '; '
      ) || `Task ${state.taskId}`
    )
  }
}

/**
 * Newest first, so the newest decision on a subject wins and any limit drops the oldest.
 * Only user declarations and recorded task state count: prior answers stay unverified.
 */
export function buildThreadSummary(
  db: DatabaseSync,
  id: string,
  header: Header,
  controls: MemoryControls,
  projectRoot?: string | null
): ThreadSummary {
  const total = Number(
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE threadId=?').get(id)?.n ?? 0
  )
  const forgotten = new Set(controls.forgotten)
  const items: ThreadSummaryItem[] = []
  const omitted = { decision: 0, constraint: 0, unfinished: 0 }
  const counts = { decision: 0, constraint: 0, unfinished: 0 }
  const subjects = new Map<string, ThreadSummaryItem>()
  const seenText = new Set<string>()
  const settledTasks = new Set<string>()
  const add = (item: ThreadSummaryItem) => {
    if (counts[item.kind] >= LIMITS[item.kind]) {
      omitted[item.kind]++
      return
    }
    counts[item.kind]++
    items.push(item)
  }
  const started = performance.now()
  let stoppedBy: ThreadSummary['coverage']['stoppedBy']
  let scanned = 0
  let excluded = 0
  let corrupt = 0
  let bytes = 0
  const rows = db
    .prepare(
      'SELECT ordinal,body,contextSequence FROM messages WHERE threadId=? ORDER BY ordinal DESC'
    )
    .iterate(id)
  for (const row of rows) {
    stoppedBy =
      scanned >= MAX_SCANNED_ROWS
        ? 'messages'
        : bytes >= MAX_SCANNED_BYTES
          ? 'bytes'
          : performance.now() - started >= MAX_SCAN_MS
            ? 'time'
            : undefined
    if (stoppedBy) break
    scanned++
    const body = String(row.body)
    bytes += body.length
    let message: ChatMessage | null = null
    try {
      message = contextRecord(JSON.parse(body))
    } catch {
      message = null
    }
    if (!message) {
      corrupt++
      continue
    }
    const ordinal = Number(row.ordinal)
    message = { ...message, contextSequence: Number(row.contextSequence) }
    if (recallExcluded({ ordinal, message }, controls, forgotten, projectRoot)) {
      excluded++
      continue
    }
    const task = message.contextResult?.workingState
    if (task && !settledTasks.has(task.taskId)) {
      // Only the newest state of a task counts: finishing it later clears the earlier one.
      settledTasks.add(task.taskId)
      const open = unfinishedText(message)
      if (open)
        add({
          kind: 'unfinished',
          sourceId: message.id,
          ordinal,
          text: open.text,
          terminal: open.terminal
        })
    }
    if (message.role !== 'user') continue
    for (const decision of declaredDecisions(message)) {
      const key = JSON.stringify([decision.scope, decision.subject])
      const newer = subjects.get(key)
      if (newer) {
        newer.corrects = (newer.corrects ?? 0) + 1
        continue
      }
      const item: ThreadSummaryItem = {
        kind: 'decision',
        sourceId: message.id,
        ordinal,
        text: clip(`${decision.subject}: ${decision.value}`)
      }
      subjects.set(key, item)
      add(item)
    }
    if (declaredDecisions(message).length) continue
    for (const line of message.content.slice(0, 32768).split('\n')) {
      if (!CONSTRAINT.test(line)) continue
      const text = clip(line)
      if (seenText.has(text)) continue
      seenText.add(text)
      add({ kind: 'constraint', sourceId: message.id, ordinal, text })
    }
  }
  const scope = {
    threadId: id,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    revision: header.revision,
    controlsRevision: controls.revision ?? 0,
    sourceEpoch: header.sourceEpoch
  }
  const coverage = {
    totalMessages: total,
    scannedMessages: scanned,
    excludedMessages: excluded,
    corruptMessages: corrupt,
    complete: scanned === total,
    ...(stoppedBy && scanned < total ? { stoppedBy } : {})
  }
  return {
    version: THREAD_SUMMARY_VERSION,
    kind: 'deterministic',
    digest: createHash('sha256')
      .update(JSON.stringify([THREAD_SUMMARY_VERSION, scope, coverage, omitted, items]))
      .digest('hex'),
    scope,
    coverage,
    omitted,
    items,
    // Outside the digest: timing varies run to run, the content it describes does not.
    elapsedMs: Math.round(performance.now() - started)
  }
}
