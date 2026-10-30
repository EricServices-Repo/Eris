import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { ChatDatabase } from '../electron/main/services/chat-database'
let dir: string, db: ChatDatabase
const thread = {
  id: 't',
  title: 'History',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 1,
  messages: []
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eris-context-events-'))
  db = new ChatDatabase(dir)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
it('commits canonical changes and outbox atomically and resumes bounded replay after restart', () => {
  db.save(thread)
  for (let i = 0; i < 8; i++)
    db.append('t', { id: String(i), role: 'user', content: 'Remember currency CAD', createdAt: 1 })
  expect(db.contextChangeStatus().complete).toBe(false)
  const partial = db.replayContextChanges(2)
  expect(partial.watermark).toBe(2)
  expect(partial.complete).toBe(false)
  db.close()
  db = new ChatDatabase(dir)
  while (!db.replayContextChanges(2).complete) {
    /* bounded catch-up */
  }
  const complete = db.contextChangeStatus()
  expect(db.replayContextChanges()).toEqual(complete)
  expect(db.get('t')!.messages).toHaveLength(8)
  expect(db.contextChanges(0, 2).events).toHaveLength(2)
  expect(db.contextCapabilities().journal).toBe('wal')
})
it('rolls outbox back with a failed canonical write and observes independent writer rewrites and controls', () => {
  db.save(thread)
  const raw = new DatabaseSync(join(dir, 'chats.sqlite'))
  try {
    const before = db.contextChangeStatus().highWatermark
    raw.exec(
      'BEGIN IMMEDIATE; UPDATE conversations SET contextRevision=contextRevision+1 WHERE id="t"; ROLLBACK;'.replaceAll(
        '"t"',
        "'t'"
      )
    )
    expect(db.contextChangeStatus().highWatermark).toBe(before)
    const other = new ChatDatabase(dir)
    try {
      other.save({
        ...thread,
        messages: [{ id: 'new', role: 'user', content: 'new source', createdAt: 1 }]
      })
      other.contextControls('t', { version: 1, forgotten: ['new'], pinned: [], afterOrdinal: 0 })
    } finally {
      other.close()
    }
    expect(db.contextHeader('t')!.controlsRevision).toBe(1)
    db.remove('t')
    db.replayContextChanges(500)
    expect(
      raw.prepare('SELECT deleted FROM context_source_catalog WHERE threadId=?').get('t')!.deleted
    ).toBe(1)
    db.save(thread)
    db.replayContextChanges(500)
    expect(
      raw.prepare('SELECT deleted FROM context_source_catalog WHERE threadId=?').get('t')!.deleted
    ).toBe(0)
  } finally {
    raw.close()
  }
})
it('resets an invalid derived cursor without changing canonical messages', () => {
  db.save(thread)
  db.replayContextChanges()
  const raw = new DatabaseSync(join(dir, 'chats.sqlite'))
  try {
    raw.exec('UPDATE context_derivation_cursor SET sequence=9999,version=99')
    expect(db.contextChangeStatus().complete).toBe(false)
    expect(db.replayContextChanges().complete).toBe(true)
  } finally {
    raw.close()
  }
  expect(db.get('t')).not.toBeNull()
})

it('never blocks canonical append/delete on a corrupt optional control row', () => {
  db.save(thread)
  const raw = new DatabaseSync(join(dir, 'chats.sqlite'))
  try {
    raw.prepare('INSERT INTO context_controls(threadId,body) VALUES(?,?)').run('t', '{broken')
    expect(() =>
      db.append('t', {
        id: 'u',
        role: 'user',
        content: 'Still save the user request',
        createdAt: 1
      })
    ).not.toThrow()
    expect(() => db.remove('t')).not.toThrow()
    expect(db.replayContextChanges(500).complete).toBe(true)
  } finally {
    raw.close()
  }
})
