import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatDatabase } from '../electron/main/services/chat-database'
import type { ChatThread } from '../src/shared/settings-schema'

let dir: string
let db: ChatDatabase | undefined
const thread = (count: number): ChatThread => ({
  id: 'thread',
  title: 'History',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 2,
  messages: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    role: index % 2 ? 'assistant' : 'user',
    content: `Message ${index}`,
    createdAt: index + 1
  }))
})
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eris-chat-db-'))
})
afterEach(() => {
  db?.close()
  db = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('transactional chat storage', () => {
  it('appends atomically, updates the title/model, and deduplicates retried message IDs', () => {
    db = new ChatDatabase(dir)
    db.save({ ...thread(0), title: 'New chat' })
    const question = {
      id: 'question',
      role: 'user' as const,
      content: 'Build a dashboard',
      createdAt: 1
    }
    db.append('thread', question, 'local:new-model')
    db.append('thread', question, 'local:new-model')
    db.append('thread', { id: 'answer', role: 'assistant', content: 'Done', createdAt: 2 })
    expect(db.get('thread')).toMatchObject({
      title: 'Build a dashboard',
      model: 'local:new-model',
      messageCount: 2
    })
  })
  it('rejects stale controls across independent connections and supports safe retry', () => {
    db = new ChatDatabase(dir)
    db.save(thread(2))
    const other = new ChatDatabase(dir)
    try {
      const a = db.memoryControls('thread'),
        b = other.memoryControls('thread')
      const first = db.memoryControls('thread', { ...a, pinned: [{ id: 'a', text: 'A' }] })
      expect(first.revision).toBe(1)
      expect(() =>
        other.memoryControls('thread', { ...b, pinned: [{ id: 'b', text: 'B' }] })
      ).toThrow('CONTEXT_CONTROLS_CONFLICT')
      expect(other.memoryControls('thread').pinned.map((p) => p.id)).toEqual(['a'])
      const latest = other.memoryControls('thread')
      const second = other.memoryControls('thread', {
        ...latest,
        pinned: [...latest.pinned, { id: 'b', text: 'B' }]
      })
      expect(second.revision).toBe(2)
      expect(db.memoryControls('thread').pinned.map((p) => p.id)).toEqual(['a', 'b'])
      expect(
        other.memoryControls('thread', {
          ...latest,
          pinned: [...latest.pinned, { id: 'b', text: 'B' }]
        })
      ).toEqual(second)
      expect(() => db!.memoryControls('thread', { ...a, afterOrdinal: 2 })).toThrow(
        'CONTEXT_CONTROLS_CONFLICT'
      )
      expect(db.memoryControls('thread').afterOrdinal).toBe(0)
      db.close()
      db = new ChatDatabase(dir)
      expect(db.memoryControls('thread').revision).toBe(2)
    } finally {
      other.close()
    }
  })
  it('rejects stale controls for a deleted and recreated conversation', () => {
    db = new ChatDatabase(dir)
    db.save(thread(1))
    const stale = db.memoryControls('thread', {
      version: 1,
      forgotten: [],
      pinned: [],
      afterOrdinal: 1
    })
    db.remove('thread')
    db.save(thread(0))
    expect(() =>
      db!.memoryControls('thread', { ...stale, pinned: [{ id: 'p', text: 'Old view' }] })
    ).toThrow('CONTEXT_CONTROLS_CONFLICT')
    expect(db.memoryControls('thread').pinned).toEqual([])
  })
  it('imports legacy history once, preserves the original, and never resurrects deleted chats', () => {
    const legacy = JSON.stringify(thread(140))
    writeFileSync(join(dir, 'thread.json'), legacy)
    db = new ChatDatabase(dir)
    expect(db.list()[0]).toMatchObject({ id: 'thread', messageCount: 140, messages: [] })
    expect(db.get('thread', { limit: 60 })).toMatchObject({ messageOffset: 80, messageCount: 140 })
    expect(readFileSync(join(dir, 'thread.json'), 'utf8')).toBe(legacy)
    db.remove('thread')
    db.close()
    db = new ChatDatabase(dir)
    expect(db.list()).toEqual([])
  })
  it('preserves unloaded messages when appending and rewinding a partial page', () => {
    db = new ChatDatabase(dir)
    db.save(thread(140))
    const recent = db.get('thread', { limit: 20 })!
    recent.messages.push({ id: 'new', role: 'user', content: 'Follow-up', createdAt: 1000 })
    db.save(recent)
    expect(db.get('thread')!.messages).toHaveLength(141)
    expect(db.get('thread')!.messages[0]!.content).toBe('Message 0')
    expect(db.get('thread', { before: 120, limit: 20 })!.messages[0]!.content).toBe('Message 100')
    recent.messages = recent.messages.slice(0, 8)
    db.save(recent)
    expect(db.get('thread')!.messages).toHaveLength(128)
    expect(db.get('thread')!.messages[127]!.content).toBe('Message 127')
  })
  it('rolls back the entire save if a message fails to serialize', () => {
    db = new ChatDatabase(dir)
    db.save(thread(4))
    const edited = thread(4)
    edited.title = 'Must roll back'
    edited.messages[0]!.content = 'Must roll back too'
    Object.assign(edited.messages[3]!, { circular: edited })
    expect(() => db!.save(edited)).toThrow()
    expect(db.get('thread')!.title).toBe('History')
    expect(db.get('thread')!.messages[0]!.content).toBe('Message 0')
  })
  it('rejects invalid offsets instead of truncating unseen history', () => {
    db = new ChatDatabase(dir)
    db.save(thread(8))
    expect(() => db!.save({ ...thread(1), messageOffset: 100 })).toThrow('Invalid chat page offset')
    expect(db.get('thread')!.messages).toHaveLength(8)
  })
  it('reports unreadable legacy transcripts and leaves their bytes untouched', () => {
    writeFileSync(join(dir, 'broken.json'), '{unfinished')
    expect(() => new ChatDatabase(dir)).toThrow('broken.json')
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{unfinished')
  })
})

describe('RAM context durable recovery', () => {
  it('pages complete history with stable ordinals and revisions, independent of UI paging', () => {
    db = new ChatDatabase(dir)
    db.save(thread(1201))
    const first = db.contextPage('thread')!
    const second = db.contextPage('thread', first.before)!
    const third = db.contextPage('thread', second.before)!
    expect(first.records).toHaveLength(500)
    expect(third.done).toBe(true)
    expect([...third.records, ...second.records, ...first.records].map((r) => r.ordinal)).toEqual(
      Array.from({ length: 1201 }, (_, i) => i)
    )
    const revision = first.revision
    db.append('thread', { id: 'new', role: 'user', content: 'new', createdAt: 2 })
    expect(db.contextPage('thread')!.revision).toBeGreaterThan(revision)
    db.save({ ...db.get('thread')!, messages: thread(2).messages })
    expect(db.contextPage('thread')!.revision).toBeGreaterThan(revision + 1)
  })
  it('advances over oversized rows, reports omitted coverage and strips reasoning and image assets', () => {
    db = new ChatDatabase(dir)
    const input = thread(3)
    input.messages[1]!.content = 'x'.repeat(4000)
    input.messages[2]!.thinking = 'private trace'
    db.save(input)
    const page = db.contextPage('thread', undefined, 1000)!
    expect(page.omitted).toBe(1)
    expect(page.done).toBe(true)
    expect(page.records.map((r) => r.ordinal)).toEqual([0, 2])
    expect(JSON.stringify(page)).not.toContain('private trace')
  })
  it('recovers explicit controls on restart, validates them and removes them with deleted conversations', () => {
    db = new ChatDatabase(dir)
    db.save(thread(2))
    const controls = {
      version: 1 as const,
      forgotten: ['0'],
      pinned: [{ id: 'p', text: 'Use CAD' }],
      afterOrdinal: 1
    }
    db.memoryControls('thread', controls)
    db.close()
    db = new ChatDatabase(dir)
    expect(db.memoryControls('thread')).toEqual({ ...controls, revision: 1 })
    expect(() => db!.memoryControls('thread', { ...controls, afterOrdinal: -1 })).toThrow()
    db.remove('thread')
    db.save(thread(0))
    expect(db.memoryControls('thread').pinned).toEqual([])
  })
})
