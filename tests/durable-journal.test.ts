import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))

import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import { boundedJournalText, journalPersistence } from '../electron/main/services/context-journal'
import { ContextPull, conversationThreadRecall } from '../electron/main/services/agent/context-pull'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import type { DurableJournalEntry } from '../src/shared/context-journal'
import type { ChatThread } from '../src/shared/settings-schema'

const THREAD = 'thread'
const FAILURE = 'AssertionError: expected ledger total 41 to equal 42'
const MIB = 1024 ** 2
let folder: string
let db: ChatDatabase

const settings = () => structuredClone(getDefaults())
const thread = (count = 4): ChatThread => ({
  id: THREAD,
  title: 'History',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 2,
  messages: Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    content: `message ${index}`,
    createdAt: 1
  }))
})
const entry = (over: Partial<DurableJournalEntry> = {}): DurableJournalEntry => ({
  ref: 'aaaaaaaaaaaa',
  sourceId: 'm2',
  runId: 'run-1',
  seq: 1,
  toolName: 'run',
  argsSummary: '{"command":"npm test"}',
  trust: 'command',
  bytes: FAILURE.length,
  at: Date.UTC(2026, 9, 31),
  projectRoot: null,
  text: FAILURE,
  ...over
})
const rows = (table: string) => {
  const raw = new DatabaseSync(join(folder, 'chats.sqlite'))
  try {
    return Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)
  } finally {
    raw.close()
  }
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'durable-journal-'))
  db = new ChatDatabase(folder)
  db.save(thread())
  vi.mocked(workspaceRequest).mockImplementation((async (request: WorkspaceRequest) =>
    handleWorkspaceRequest({ ...request, dir: folder } as WorkspaceRequest)) as never)
})
afterEach(() => {
  db.close()
  closeChatDatabases()
  rmSync(folder, { recursive: true, force: true })
  vi.mocked(workspaceRequest).mockReset()
})

describe('durable run journal', () => {
  it('finds tool output after a restart, with its source ref and date', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    db.close()
    db = new ChatDatabase(folder)
    const [hit] = db.journalSearch(THREAD, 'ledger total', 5)
    expect(hit.entry).toMatchObject({ ref: 'aaaaaaaaaaaa', sourceId: 'm2', toolName: 'run' })
    expect(hit.entry.at).toBe(Date.UTC(2026, 9, 31))
    expect(hit.snippet).toContain('ledger total 41')
    expect(db.journalRead(THREAD, hit.entry.ref)).toMatchObject({ status: 'found', text: FAILURE })
  })

  it('removes entries and index rows with the thread', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    expect(rows('context_journal_terms')).toBeGreaterThan(0)
    db.remove(THREAD)
    expect(rows('context_journal')).toBe(0)
    expect(rows('context_journal_terms')).toBe(0)
  })

  it('removes entries when the source that started the run is forgotten', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    db.memoryControls(THREAD, { ...db.memoryControls(THREAD), forgotten: ['m2'] })
    expect(rows('context_journal')).toBe(0)
    expect(rows('context_journal_terms')).toBe(0)
    expect(db.journalSearch(THREAD, 'ledger', 5)).toEqual([])
  })

  it('removes entries behind a cutoff and after a rewind', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    db.journalWrite(THREAD, entry({ ref: 'bbbbbbbbbbbb', sourceId: 'm0', seq: 2 }), 16 * MIB)
    db.save({ ...thread(2) })
    expect(db.journalRead(THREAD, 'aaaaaaaaaaaa').status).toBe('unavailable')
    expect(db.journalRead(THREAD, 'bbbbbbbbbbbb').status).toBe('found')
    const controls = db.memoryControls(THREAD)
    db.memoryControls(THREAD, { ...controls, afterOrdinal: 2, afterSequence: undefined })
    expect(db.journalRead(THREAD, 'bbbbbbbbbbbb').status).toBe('unavailable')
    expect(rows('context_journal')).toBe(0)
  })

  it('hides a row whose source vanished outside the save path', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    const raw = new DatabaseSync(join(folder, 'chats.sqlite'))
    raw.prepare('DELETE FROM messages WHERE threadId=? AND id=?').run(THREAD, 'm2')
    raw.close()
    expect(db.journalRead(THREAD, 'aaaaaaaaaaaa').status).toBe('unavailable')
    expect(db.journalSearch(THREAD, 'ledger', 5)).toEqual([])
  })

  it('clears rows left by another writer when change events replay', () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    const raw = new DatabaseSync(join(folder, 'chats.sqlite'))
    raw.prepare('DELETE FROM messages WHERE threadId=? AND id=?').run(THREAD, 'm2')
    raw.prepare('UPDATE conversations SET contextRevision=contextRevision+1 WHERE id=?').run(THREAD)
    raw.close()
    expect(rows('context_journal')).toBe(1)
    db.replayContextChanges(500)
    expect(rows('context_journal')).toBe(0)
    expect(rows('context_journal_terms')).toBe(0)
  })

  it('refuses output for a source that does not exist', () => {
    expect(db.journalWrite(THREAD, entry({ sourceId: 'missing' }), 16 * MIB)).toBe(false)
    expect(rows('context_journal')).toBe(0)
  })

  it('keeps projects apart', () => {
    db.journalWrite(THREAD, entry({ projectRoot: '/repo/a' }), 16 * MIB)
    expect(db.journalSearch(THREAD, 'ledger', 5, '/repo/b')).toEqual([])
    expect(db.journalRead(THREAD, 'aaaaaaaaaaaa', '/repo/b').status).toBe('unavailable')
    expect(db.journalSearch(THREAD, 'ledger', 5, '/repo/a')).toHaveLength(1)
  })

  it('evicts oldest output past the budget and leaves a marker', () => {
    const text = (word: string) => `${word} ${'x'.repeat(600)}`
    for (const [seq, word] of ['alpha', 'bravo', 'charlie'].entries())
      db.journalWrite(
        THREAD,
        entry({ ref: word.padEnd(12, '0'), seq, at: seq, text: text(word) }),
        1400
      )
    const oldest = db.journalRead(THREAD, 'alpha0000000')
    expect(oldest).toMatchObject({ status: 'omitted', entry: { omitted: 'over-thread-budget' } })
    expect(db.journalRead(THREAD, 'charlie00000').status).toBe('found')
    expect(db.journalSearch(THREAD, 'alpha', 5)).toEqual([])
    const [marker] = db
      .journalSearch(THREAD, 'npm test', 5)
      .filter((hit) => hit.entry.ref === 'alpha0000000')
    expect(marker.entry.omitted).toBe('over-thread-budget')
  })

  it('stores metadata only for an entry larger than the whole budget', () => {
    db.journalWrite(THREAD, entry({ text: 'y'.repeat(4096) }), 1024)
    expect(db.journalRead(THREAD, 'aaaaaaaaaaaa')).toMatchObject({
      status: 'omitted',
      entry: { omitted: 'over-thread-budget' }
    })
  })

  it('filters secrets and keeps the tail of a long failure', () => {
    expect(boundedJournalText('token=abc123 failed')).toBe('[redacted secret] failed')
    const long = `${'a\n'.repeat(MIB)}password: hunter2\nFINAL ERROR LINE`
    const kept = boundedJournalText(long)
    expect(kept.length).toBeLessThan(1.1 * MIB)
    expect(kept).toContain('characters not retained')
    expect(kept).toContain('FINAL ERROR LINE')
    expect(kept).not.toContain('hunter2')
  })

  it('never saves half a secret when the tail starts inside one', () => {
    const secret = `password: ${'s'.repeat(300 * 1024)}`
    const kept = boundedJournalText(`${'a\n'.repeat(MIB)}${secret}\nend`)
    expect(kept).not.toContain('sss')
    expect(kept.endsWith('end')).toBe(true)
  })
})

describe('run journal persistence policy', () => {
  const source = { root: null, threadId: THREAD, sourceId: 'm2', projectRoot: null }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  const appendThrough = async (persist: ReturnType<typeof journalPersistence>) => {
    const journal = new RunJournal(
      { runId: 'run-2', taskId: 'task', memoryKey: 'journal:test' },
      undefined,
      persist
    )
    const appended = await journal.append({
      toolName: 'run',
      toolCallId: 'call',
      args: { command: 'npm test' },
      content: `${FAILURE}\napi_key=abc123`
    })
    return { journal, appended }
  }

  it('saves redacted output through the worker lane and survives the run closing', async () => {
    const { journal, appended } = await appendThrough(journalPersistence(source, settings()))
    journal.close()
    await flush()
    const read = db.journalRead(THREAD, appended.ref)
    expect(read).toMatchObject({ status: 'found' })
    expect(read.status === 'found' && read.text).toContain('[redacted secret]')
    expect(read.status === 'found' && read.text).not.toContain('abc123')
  })

  it('turns off without affecting recovery inside the run', async () => {
    const off = settings()
    off.agent.contextMemory.persistToolOutput = false
    expect(journalPersistence(source, off)).toBeUndefined()
    const { journal, appended } = await appendThrough(undefined)
    expect(await journal.read(appended.ref)).toMatchObject({ status: 'found' })
    journal.close()
    expect(rows('context_journal')).toBe(0)
  })

  it('does not persist when recall is disabled or the run has no source', () => {
    const disabled = settings()
    disabled.agent.contextMemory.enabled = false
    expect(journalPersistence(source, disabled)).toBeUndefined()
    expect(journalPersistence({ ...source, sourceId: undefined }, settings())).toBeUndefined()
  })

  it('keeps only metadata when the memory for a queued copy is refused', async () => {
    const reserve = vi.spyOn(contextMemoryStore, 'reserve').mockReturnValueOnce(null)
    const persist = journalPersistence(source, settings())!
    const { journal, appended } = await appendThrough((entry, content) => persist(entry, content))
    journal.close()
    await flush()
    reserve.mockRestore()
    expect(db.journalRead(THREAD, appended.ref)).toMatchObject({
      status: 'omitted',
      entry: { omitted: 'memory-pressure' }
    })
  })

  it('a failed save never costs the run its tool result', async () => {
    vi.mocked(workspaceRequest).mockRejectedValue(new Error('worker gone'))
    const { journal, appended } = await appendThrough(journalPersistence(source, settings()))
    await flush()
    expect(await journal.read(appended.ref)).toMatchObject({ status: 'found' })
    journal.close()
    expect(contextMemoryStore.ledger.reservedBytes).toBe(0)
  })
})

describe('recalling earlier tool output', () => {
  const pull = (allowed = true) => {
    const journal = new RunJournal({ runId: 'later', taskId: 'later', memoryKey: 'journal:later' })
    const events: string[] = []
    return {
      journal,
      events,
      pull: new ContextPull({
        journal,
        thread: conversationThreadRecall(
          { root: null, threadId: THREAD, projectRoot: null },
          settings()
        ),
        allowed: () => allowed,
        budgetTokens: () => 8000,
        remainingTokens: () => 8000,
        record: (event) => events.push(event.status)
      })
    }
  }

  it('labels a recalled test result historical, in search and in read', async () => {
    db.journalWrite(THREAD, entry({ trust: 'untrusted' }), 16 * MIB)
    const { pull: tools, journal } = pull()
    const found = await tools.search({ query: 'ledger total', scope: 'thread' })
    expect(found.detail).toContain('ref:jaaaaaaaaaaaa')
    expect(found.detail).toContain('recorded 2026-10-31')
    expect(found.detail).toContain('historical: says nothing about the current files')
    expect(found.detail).toContain('untrusted external content')
    const read = await tools.read({ ref: 'jaaaaaaaaaaaa' })
    expect(read.ok).toBe(true)
    expect(read.detail).toContain(FAILURE)
    expect(read.detail).toContain('historical: says nothing about the current files')
    journal.close()
  })

  it('reads only refs a search returned', async () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    const { pull: tools, journal } = pull()
    expect((await tools.read({ ref: 'jaaaaaaaaaaaa' })).detail).toContain('Unknown ref')
    journal.close()
  })

  it('refuses a read after the source is forgotten between search and read', async () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    const { pull: tools, journal } = pull()
    await tools.search({ query: 'ledger', scope: 'thread' })
    db.memoryControls(THREAD, { ...db.memoryControls(THREAD), forgotten: ['m2'] })
    const read = await tools.read({ ref: 'jaaaaaaaaaaaa' })
    expect(read.ok).toBe(false)
    expect(read.detail).toContain('can no longer be read')
    journal.close()
  })

  it('returns nothing to a destination that may not see history', async () => {
    db.journalWrite(THREAD, entry(), 16 * MIB)
    const { pull: tools, journal } = pull(false)
    const found = await tools.search({ query: 'ledger', scope: 'thread' })
    expect(found.ok).toBe(false)
    expect(found.detail).not.toContain('ledger')
    journal.close()
  })

  it('states when the output is gone rather than reporting no match', async () => {
    db.journalWrite(THREAD, entry({ text: null, omitted: 'memory-pressure' }), 16 * MIB)
    const { pull: tools, journal } = pull()
    const found = await tools.search({ query: 'npm test', scope: 'thread' })
    expect(found.detail).toContain('output not retained: memory-pressure')
    expect(found.detail).not.toContain('No matches')
    const read = await tools.read({ ref: 'jaaaaaaaaaaaa' })
    expect(read.ok).toBe(false)
    expect(read.detail).toContain('output not retained: memory-pressure')
    journal.close()
  })

  it('does not list this run twice', async () => {
    const { pull: tools, journal } = pull()
    const live = await journal.append({
      toolName: 'run',
      toolCallId: 'c',
      content: FAILURE
    })
    db.journalWrite(THREAD, entry({ ref: live.ref }), 16 * MIB)
    const found = await tools.search({ query: 'ledger total' })
    expect(found.detail.match(/ledger total 41/g)).toHaveLength(1)
    journal.close()
  })
})
