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
