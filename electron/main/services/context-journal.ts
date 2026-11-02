import type { DurableJournalEntry } from '../../../src/shared/context-journal'
import { ContextMemorySettingsSchema } from '../../../src/shared/context-memory'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type { JournalEntry } from './agent/run-journal'
import { logWarn } from './logger'
import { contextMemoryStore, redactSensitive } from './context-memory-store'
import { abortable } from './context-hydration'
import { conversationDirectory, memoryKey } from './context-memory'
import { workspaceRequest } from './workspace-worker-client'

const MIB = 1024 ** 2
/** One entry may be most of a page set, never most of a thread's budget. */
const MAX_ENTRY_CHARS = MIB
const TAIL_CHARS = 256 * 1024
const REQUEST_MS = 2_000
/** A decoded string takes up to two bytes per character while it waits for the worker. */
const BYTES_PER_CHAR = 2

/**
 * Keeps the head and the tail, where a failing command prints its summary. The tail starts
 * on a whole line: redaction needs the key beside a secret, and a cut could separate them.
 */
export function boundedJournalText(content: string) {
  if (content.length <= MAX_ENTRY_CHARS) return redactSensitive(content)
  const head = content.slice(0, MAX_ENTRY_CHARS - TAIL_CHARS)
  const tailFrom = content.indexOf('\n', content.length - TAIL_CHARS)
  const tail = tailFrom < 0 ? '' : content.slice(tailFrom + 1)
  const dropped = content.length - head.length - tail.length
  return redactSensitive(`${head}\n[${dropped} characters not retained]\n${tail}`)
}

export type JournalPersist = (entry: JournalEntry, content: string) => void

/** Undefined unless this run may keep tool output past its end. */
export function journalPersistence(
  source: {
    root: string | null
    threadId: string
    sourceId: string | undefined
    projectRoot: string | null
  },
  settings: AppSettings
): JournalPersist | undefined {
  const policy = ContextMemorySettingsSchema.parse(settings.agent.contextMemory ?? {})
  const { root, threadId, sourceId, projectRoot } = source
  if (!sourceId || !policy.enabled || !policy.persistToolOutput) return undefined
  const dir = conversationDirectory(root)
  const key = memoryKey(root, threadId)
  return (entry, content) => {
    const chars = Math.min(content.length, MAX_ENTRY_CHARS)
    // The copy waits in the worker queue, so it is charged like any other held text.
    const reservation = contextMemoryStore.reserve(key, chars * BYTES_PER_CHAR)
    const durable: DurableJournalEntry = {
      ref: entry.ref,
      sourceId,
      runId: entry.runId,
      seq: entry.seq,
      toolName: entry.toolName,
      argsSummary: entry.argsSummary,
      trust: entry.trust,
      bytes: entry.bytes,
      at: entry.at,
      projectRoot,
      text: reservation ? boundedJournalText(content) : null,
      ...(reservation ? {} : { omitted: 'memory-pressure' as const })
    }
    void workspaceRequest({
      type: 'context-journal-write',
      dir,
      id: threadId,
      entry: durable,
      maxBytes: policy.journalThreadMiB * MIB
    })
      .catch(() => logWarn('Tool output was not saved to the run journal'))
      .finally(() => reservation?.release())
  }
}

const bounded = <T>(work: Promise<T>, signal?: AbortSignal) =>
  abortable(work, [AbortSignal.timeout(REQUEST_MS), ...(signal ? [signal] : [])])

export async function searchDurableJournal(
  root: string | null,
  id: string,
  query: string,
  limit: number,
  projectRoot: string | null,
  signal?: AbortSignal
) {
  return bounded(
    workspaceRequest({
      type: 'context-journal-search',
      dir: conversationDirectory(root),
      id,
      query,
      limit,
      projectRoot
    }),
    signal
  )
}

export async function readDurableJournal(
  root: string | null,
  id: string,
  ref: string,
  projectRoot: string | null,
  signal?: AbortSignal
) {
  return bounded(
    workspaceRequest({
      type: 'context-journal-read',
      dir: conversationDirectory(root),
      id,
      ref,
      projectRoot
    }),
    signal
  )
}
