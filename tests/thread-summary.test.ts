import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))

import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import { ContextPull, conversationThreadRecall } from '../electron/main/services/agent/context-pull'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import type { ChatMessage, ChatThread } from '../src/shared/settings-schema'
import {
  THREAD_SUMMARY_REF,
  threadSummaryText,
  type ThreadSummary
} from '../src/shared/thread-summary'
import type { ThreadWorkingState } from '../src/shared/thread-working-state'

const THREAD = 'long'
let folder: string
let db: ChatDatabase

const user = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
const assistant = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  createdAt: 1,
  ...extra
})
const state = (terminal: string, taskId = 'task-1'): ThreadWorkingState => ({
  version: 1,
  taskId,
  taskRevision: 1,
  sourceMessageId: 'u',
  projectRoot: null,
  terminal,
  obligations: [{ id: 'o', text: 'Add the refund path', state: 'pending', effectIds: [] }],
  effects: [],
  checks: [],
  questions: [{ id: 'q', text: 'Which currency?', answered: false }],
  omitted: 0
})
const result = (id: string, terminal: string, taskId?: string) =>
  assistant(id, `Task ${terminal}`, {
    contextResult: {
      taskId: taskId ?? 'task-1',
      terminal,
      projectRoot: null,
      changedFiles: [],
      workingState: state(terminal, taskId)
    }
  } as Partial<ChatMessage>)
const thread = (messages: ChatMessage[]): ChatThread => ({
  id: THREAD,
  title: 'Long',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 2,
  messages
})
const summary = (projectRoot?: string | null) => db.threadSummary(THREAD, projectRoot)!
const ofKind = (value: ThreadSummary, kind: string) =>
  value.items.filter((item) => item.kind === kind)

const LABELLED = [
  user('d1', 'Remember: invoice currency is USD'),
  assistant('a1', 'Remember: the database must use Oracle'),
  user('c1', 'Never push to the release branch'),
  ...Array.from({ length: 200 }, (_, i) => user(`f${i}`, `Discussion ${i} about layouts`)),
  user('d2', 'Correction: invoice currency is GBP'),
  result('t1', 'failed')
]

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'thread-summary-'))
  db = new ChatDatabase(folder)
  db.save(thread(LABELLED))
  vi.mocked(workspaceRequest).mockImplementation((async (request: WorkspaceRequest) =>
    handleWorkspaceRequest({ ...request, dir: folder } as WorkspaceRequest)) as never)
})
afterEach(() => {
  db.close()
  closeChatDatabases()
  rmSync(folder, { recursive: true, force: true })
  vi.mocked(workspaceRequest).mockReset()
  contextMemoryStore.clear()
})

describe('deterministic thread summary', () => {
  it('states its coverage, digest, version and scope', () => {
    const value = summary()
    expect(value).toMatchObject({ version: 1, kind: 'deterministic' })
    expect(value.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(value.scope.threadId).toBe(THREAD)
    expect(value.coverage).toMatchObject({
      totalMessages: LABELLED.length,
      scannedMessages: LABELLED.length,
      excludedMessages: 0,
      complete: true
    })
  })

  it('keeps the correction and says what it replaced', () => {
    const decisions = ofKind(summary(), 'decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ sourceId: 'd2', corrects: 1 })
    expect(decisions[0]!.text).toContain('GBP')
  })

  it('cites the source of every item', () => {
    for (const item of summary().items) {
      expect(item.sourceId).toBeTruthy()
      expect(item.ordinal).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps a failed task distinct and clears one that finished later', () => {
    expect(ofKind(summary(), 'unfinished')[0]).toMatchObject({
      sourceId: 't1',
      terminal: 'failed'
    })
    expect(ofKind(summary(), 'unfinished')[0]!.text).toContain('Add the refund path')
    db.save(thread([...LABELLED, result('t2', 'done')]))
    expect(ofKind(summary(), 'unfinished')).toEqual([])
  })

  it('never takes a decision or constraint from assistant prose', () => {
    expect(JSON.stringify(summary().items)).not.toContain('Oracle')
  })

  it('drops a forgotten source and counts the exclusion', () => {
    db.memoryControls(THREAD, { ...db.memoryControls(THREAD), forgotten: ['c1'] })
    const value = summary()
    expect(JSON.stringify(value.items)).not.toContain('release branch')
    expect(value.coverage.excludedMessages).toBe(1)
  })

  it('falls back to the older decision when the correction is forgotten', () => {
    db.memoryControls(THREAD, { ...db.memoryControls(THREAD), forgotten: ['d2'] })
    expect(ofKind(summary(), 'decision')[0]).toMatchObject({ sourceId: 'd1' })
  })

  it('changes when a source is rewritten or deleted', () => {
    const before = summary()
    const rewritten = LABELLED.map((row) =>
      row.id === 'c1' ? user('c1', 'Never push to the staging branch') : row
    )
    db.save(thread(rewritten))
    const after = summary()
    expect(after.digest).not.toBe(before.digest)
    expect(JSON.stringify(after.items)).toContain('staging')
    expect(JSON.stringify(after.items)).not.toContain('release branch')
    db.save(thread(rewritten.filter((row) => row.id !== 'c1')))
    expect(JSON.stringify(summary().items)).not.toContain('staging')
  })

  it('is gone with the thread', () => {
    db.remove(THREAD)
    expect(db.threadSummary(THREAD)).toBeNull()
  })

  it('respects project scope', () => {
    const scoped = { ...user('p', 'Always use tabs'), contextProjectRoot: '/repo/a' }
    db.save(thread([...LABELLED, scoped]))
    expect(JSON.stringify(summary('/repo/b').items)).not.toContain('tabs')
    expect(JSON.stringify(summary('/repo/a').items)).toContain('tabs')
  })

  it('reports what the limits dropped, keeping the newest', () => {
    const many = Array.from({ length: 40 }, (_, i) => user(`m${i}`, `Always rule ${i}`))
    db.save(thread(many))
    const value = summary()
    expect(ofKind(value, 'constraint')).toHaveLength(16)
    expect(value.omitted.constraint).toBe(24)
    expect(JSON.stringify(value.items)).toContain('rule 39')
    expect(JSON.stringify(value.items)).not.toContain('rule 0"')
    expect(threadSummaryText(value)).toContain('24 items over the limit')
  })

  it('says so for an empty conversation', () => {
    db.save(thread([]))
    expect(threadSummaryText(summary())).toContain('Nothing recorded yet.')
  })
})

describe('reading the summary through context_read', () => {
  const pull = (allowed = true, withThread = true) => {
    const journal = new RunJournal({ runId: 'r', taskId: 'r', memoryKey: 'summary:r' })
    const tools = new ContextPull({
      journal,
      thread: withThread
        ? conversationThreadRecall(
            { root: null, threadId: THREAD, projectRoot: null },
            structuredClone(getDefaults())
          )
        : undefined,
      allowed: () => allowed,
      budgetTokens: () => 8000,
      remainingTokens: () => 8000,
      record: () => undefined
    })
    return { journal, tools }
  }

  it('returns it as historical evidence, without calling a model', async () => {
    const { journal, tools } = pull()
    const read = await tools.read({ ref: THREAD_SUMMARY_REF })
    expect(read.ok).toBe(true)
    expect(read.detail).toContain('HISTORICAL EVIDENCE')
    expect(read.detail).toContain('deterministic')
    expect(read.detail).toContain('GBP')
    journal.close()
  })

  it('filters secrets from what it returns', async () => {
    db.save(thread([user('s', 'Remember to rotate password: hunter2')]))
    const { journal, tools } = pull()
    const read = await tools.read({ ref: THREAD_SUMMARY_REF })
    expect(read.detail).not.toContain('hunter2')
    journal.close()
  })

  it('is refused for a destination that may not see history', async () => {
    const { journal, tools } = pull(false)
    const read = await tools.read({ ref: THREAD_SUMMARY_REF })
    expect(read.ok).toBe(false)
    expect(read.detail).not.toContain('GBP')
    journal.close()
  })

  it('degrades to search when it is unavailable, leaving recall working', async () => {
    const noThread = pull(true, false)
    expect((await noThread.tools.read({ ref: THREAD_SUMMARY_REF })).detail).toContain(
      'No thread summary is available'
    )
    noThread.journal.close()
    vi.mocked(workspaceRequest).mockImplementation((async (request: WorkspaceRequest) => {
      if (request.type === 'context-thread-summary') throw new Error('worker gone')
      return handleWorkspaceRequest({ ...request, dir: folder } as WorkspaceRequest)
    }) as never)
    const failing = pull()
    expect((await failing.tools.read({ ref: THREAD_SUMMARY_REF })).ok).toBe(false)
    const search = await failing.tools.search({ query: 'invoice currency', scope: 'thread' })
    expect(search.ok).toBe(true)
    expect(search.detail).toContain('GBP')
    failing.journal.close()
  })
})
