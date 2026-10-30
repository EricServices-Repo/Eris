import { afterEach, beforeEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatDatabase } from '../electron/main/services/chat-database'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
let dir: string, db: ChatDatabase | undefined
const message = (id: string, content = 'Old discussion'): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
function save(messages: ChatMessage[]) {
  return db!.save({
    id: 't',
    title: 'History',
    model: 'local:test',
    messages,
    createdAt: 1,
    updatedAt: 1
  })
}
async function recall() {
  const page = db!.contextPage('t')!,
    store = new ContextMemoryStore()
  store.install(
    't',
    {
      revision: page.revision,
      total: page.messageCount,
      records: page.records,
      controls: db!.contextControls('t'),
      partial: false
    },
    store.token('t')
  )
  return store.select('t', 'currency')
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eris-sequences-'))
})
afterEach(() => {
  db?.close()
  db = undefined
  rmSync(dir, { recursive: true, force: true })
})
it('keeps new messages eligible after rewind and restart without reusing source sequences', async () => {
  db = new ChatDatabase(dir)
  save(Array.from({ length: 8 }, (_, i) => message(String(i))))
  const controls = db.contextControls('t', { ...emptyMemoryControls(), afterOrdinal: 8 })
  expect(controls.afterSequence).toBe(8)
  save([message('0'), message('1')])
  const next = db.append('t', message('new', 'Remember: currency CAD'))
  expect(next.contextSequence).toBe(9)
  expect(next.messages.map((m) => m.contextSequence)).toEqual([1, 2, 9])
  expect((await recall()).prompt.text).toContain('CAD')
  db.close()
  db = new ChatDatabase(dir)
  expect(db.contextControls('t').afterSequence).toBe(8)
  expect((await recall()).inspection.facts.map((f) => f.sourceId)).toEqual(['new'])
})
it('binds a legacy ordinal cutoff before truncating its original sources', async () => {
  db = new ChatDatabase(dir)
  save(Array.from({ length: 8 }, (_, i) => message(String(i))))
  db.memoryControls('t', { ...emptyMemoryControls(), afterOrdinal: 8 })
  save([message('0'), message('1')])
  db.append('t', message('new', 'Remember: currency CAD'))
  expect(db.contextControls('t').afterSequence).toBe(8)
  expect((await recall()).prompt.text).toContain('CAD')
})
it('gives a rewritten source a fresh sequence even when the ID and ordinal are reused', async () => {
  db = new ChatDatabase(dir)
  save([message('same', 'Remember: currency USD')])
  db.contextControls('t', { ...emptyMemoryControls(), afterOrdinal: 1 })
  save([message('same', 'Remember: currency CAD')])
  expect(db.get('t')!.messages[0].contextSequence).toBe(2)
  expect((await recall()).prompt.text).toContain('CAD')
  expect((await recall()).prompt.text).not.toContain('USD')
})
it('preserves unseen prefix identities on partial saves and ignores client-supplied sequences', () => {
  db = new ChatDatabase(dir)
  save(Array.from({ length: 10 }, (_, i) => message(String(i))))
  const page = db.get('t', { limit: 2 })!
  page.messages.push({ ...message('fresh'), contextSequence: 999999 })
  db.save(page)
  expect(db.get('t')!.messages.map((m) => m.contextSequence)).toEqual(
    Array.from({ length: 11 }, (_, i) => i + 1)
  )
  const duplicate = db.append('t', { ...message('fresh'), contextSequence: 999999 })
  expect(duplicate.contextSequence).toBe(11)
})
it('rebinds a later clear action while ordinary pin edits keep the original cutoff', () => {
  db = new ChatDatabase(dir)
  save([message('0'), message('1')])
  const first = db.contextControls('t', { ...emptyMemoryControls(), afterOrdinal: 2 })
  save([message('0')])
  db.append('t', message('new'))
  const pinned = db.contextControls('t', { ...first, pinned: [{ id: 'p', text: 'Note' }] })
  expect(pinned.afterSequence).toBe(2)
  const cleared = db.contextControls('t', {
    ...pinned,
    afterOrdinal: 2,
    afterSequence: undefined,
    pinned: []
  })
  expect(cleared.afterSequence).toBe(3)
})
it('migrates old SQLite rows and cutoffs transactionally and keeps future sources eligible', async () => {
  const old = new DatabaseSync(join(dir, 'chats.sqlite'))
  old.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT,model TEXT,createdAt INTEGER,updatedAt INTEGER,messageCount INTEGER,contextRevision INTEGER);
 CREATE TABLE messages(threadId TEXT,ordinal INTEGER,id TEXT,body TEXT,PRIMARY KEY(threadId,ordinal));
 CREATE TABLE migrations(name TEXT PRIMARY KEY);
 CREATE TABLE context_controls(threadId TEXT PRIMARY KEY,body TEXT);`)
  old
    .prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?)')
    .run('t', 'History', 'local:test', 1, 1, 3, 4)
  for (let i = 0; i < 3; i++)
    old
      .prepare('INSERT INTO messages VALUES (?,?,?,?)')
      .run('t', i, String(i), JSON.stringify(message(String(i))))
  old
    .prepare('INSERT INTO context_controls VALUES (?,?)')
    .run('t', JSON.stringify({ ...emptyMemoryControls(), afterOrdinal: 3 }))
  old.prepare('INSERT INTO migrations VALUES (?)').run('legacy-json')
  old.close()
  db = new ChatDatabase(dir)
  expect(db.get('t')!.messages.map((m) => m.contextSequence)).toEqual([1, 2, 3])
  expect(db.contextControls('t').afterSequence).toBe(3)
  save([])
  db.append('t', message('new', 'Remember: currency CAD'))
  expect(db.get('t')!.messages[0].contextSequence).toBe(4)
  expect((await recall()).prompt.text).toContain('CAD')
})

it('RAM-CTX-009 checks inspector source identity inside the controls transaction', () => {
  db = new ChatDatabase(dir)
  save([message('old')])
  const source = db!.contextHeader('t')!
  db!.append('t', message('new'))
  expect(() =>
    db!.contextControls(
      't',
      { ...emptyMemoryControls(), pinned: [{ id: 'p', text: 'Old snapshot' }] },
      source
    )
  ).toThrow('STALE_CONTEXT_INSPECTION')
  expect(db!.contextControls('t').pinned).toEqual([])
  const replacement = db!.contextHeader('t')!
  db!.remove('t')
  save([message('replacement')])
  expect(() => db!.contextControls('t', emptyMemoryControls(), replacement)).toThrow(
    'STALE_CONTEXT_INSPECTION'
  )
  const current = db!.contextHeader('t')!
  expect(
    db!.contextControls(
      't',
      { ...emptyMemoryControls(), pinned: [{ id: 'p', text: 'Current snapshot' }] },
      current
    ).pinned[0].text
  ).toBe('Current snapshot')
})
