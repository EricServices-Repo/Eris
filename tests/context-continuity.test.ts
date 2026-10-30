import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase } from '../electron/main/services/chat-database'
import {
  ContextMemoryStore,
  contextMemoryStore
} from '../electron/main/services/context-memory-store'
import {
  conversationContext,
  updateConversationMemory,
  memoryKey
} from '../electron/main/services/context-memory'
import { getDefaults } from '../electron/main/services/settings'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
let dir: string, db: ChatDatabase
const message = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
function save(messages: ChatMessage[]) {
  return db.save({
    id: 't',
    title: 'History',
    model: 'local:test',
    messages,
    createdAt: 1,
    updatedAt: 1
  })
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eris-continuity-'))
  db = new ChatDatabase(dir)
  contextMemoryStore.clear()
  contextMemoryStore.configure(getDefaults().agent.contextMemory)
  vi.mocked(workspaceRequest).mockImplementation(async (req) => {
    if (req.type === 'context-header') return db.contextHeader(req.id) as never
    if (req.type === 'context-controls') return db.memoryControls(req.id, req.write) as never
    if (req.type === 'context-page') return db.contextPage(req.id, req.before) as never
    throw Error('Unexpected request')
  })
})
afterEach(() => {
  contextMemoryStore.clear()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
it('invalidates revision gaps and overlapping source rewrites instead of advertising fresh stale history', async () => {
  const store = new ContextMemoryStore()
  const install = () =>
    store.install(
      't',
      {
        revision: 1,
        total: 1,
        records: [{ ordinal: 0, message: message('same', 'Remember: currency USD') }],
        controls: emptyMemoryControls(),
        partial: false
      },
      store.token('t')
    )
  install()
  store.append(
    't',
    3,
    2,
    [message('same', 'Remember: currency CAD'), message('new', 'Question')],
    0
  )
  expect(store.has('t')).toBe(false)
  install()
  store.append(
    't',
    2,
    2,
    [message('same', 'Remember: currency CAD'), message('new', 'Question')],
    0
  )
  expect(store.has('t')).toBe(false)
  install()
  store.append('t', 1, 1, [message('different', 'Remember: currency CAD')], 0)
  expect(store.has('t')).toBe(false)
})
it('keeps coherent appends and identical retries warm', async () => {
  const store = new ContextMemoryStore(),
    old = message('old', 'Remember: currency CAD'),
    next = message('new', 'Question')
  store.install(
    't',
    {
      revision: 1,
      sourceEpoch: 'epoch',
      total: 1,
      records: [{ ordinal: 0, message: old }],
      controls: emptyMemoryControls(),
      partial: false
    },
    store.token('t')
  )
  store.append('t', 2, 2, [old, next], 0, 'epoch')
  store.append('t', 2, 2, [old, next], 0, 'epoch')
  expect((await store.select('t', 'currency')).prompt.manifest).toMatchObject({
    revision: 2,
    retainedMessages: 2
  })
  store.append('t', 1, 1, [old], 0, 'epoch')
  expect((await store.select('t', 'currency')).prompt.manifest.revision).toBe(2)
})
it('reloads an external rewrite outside the returned append tail', async () => {
  save(
    Array.from({ length: 200 }, (_, i) =>
      message(String(i), i === 0 ? 'Remember: currency USD' : `Discussion ${i}`)
    )
  )
  expect((await conversationContext(null, 't', 'currency', getDefaults())).prompt.text).toContain(
    'USD'
  )
  const other = new ChatDatabase(dir)
  try {
    const rewritten = other.get('t')!
    rewritten.messages[0].content = 'Remember: currency CAD'
    other.save(rewritten)
    const tail = other.append('t', message('new', 'Question'))
    expect(tail.messageOffset).toBeGreaterThan(0)
    updateConversationMemory(null, tail)
    expect(contextMemoryStore.has(memoryKey(null, 't'))).toBe(false)
    const result = await conversationContext(null, 't', 'currency', getDefaults())
    expect(result.prompt.text).toContain('CAD')
    expect(result.prompt.text).not.toContain('USD')
    expect(result.prompt.manifest.revision).toBe(tail.contextRevision)
  } finally {
    other.close()
  }
})
it('validates external rewrites even when no local append notification arrives', async () => {
  save([message('same', 'Remember: currency USD')])
  await conversationContext(null, 't', 'currency', getDefaults())
  const other = new ChatDatabase(dir)
  try {
    const thread = other.get('t')!
    thread.messages[0].content = 'Remember: currency CAD'
    other.save(thread)
    const result = await conversationContext(null, 't', 'currency', getDefaults())
    expect(result.prompt.text).toContain('CAD')
    expect(result.prompt.text).not.toContain('USD')
  } finally {
    other.close()
  }
})
it('does not reuse a cache after the database is replaced at the same path', async () => {
  const original = save([message('same', 'Remember: private USD')])
  await conversationContext(null, 't', 'currency', getDefaults())
  db.close()
  rmSync(dir, { recursive: true, force: true })
  db = new ChatDatabase(dir)
  const replacement = save([message('same', 'Remember: public CAD')])
  expect(replacement.contextEpoch).not.toBe(original.contextEpoch)
  const result = await conversationContext(null, 't', 'currency', getDefaults())
  expect(result.prompt.text).toContain('CAD')
  expect(result.prompt.text).not.toContain('USD')
})
it('rejects stale cache reuse when canonical metadata cannot be validated', async () => {
  save([message('same', 'Remember: currency USD')])
  await conversationContext(null, 't', 'currency', getDefaults())
  vi.mocked(workspaceRequest).mockRejectedValue(Error('Header unavailable'))
  await expect(conversationContext(null, 't', 'currency', getDefaults())).rejects.toThrow(
    'Header unavailable'
  )
})
it('changes source incarnation after delete and recreation but preserves it across restart', () => {
  const a = save([message('a', 'Old')]).contextEpoch
  db.close()
  db = new ChatDatabase(dir)
  expect(db.contextHeader('t')?.sourceEpoch).toBe(a)
  db.remove('t')
  const b = save([message('b', 'New')]).contextEpoch
  expect(b).not.toBe(a)
  expect(db.contextPage('t')?.sourceEpoch).toBe(b)
})
