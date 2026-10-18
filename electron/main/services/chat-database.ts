import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ChatThread, ChatMessage } from '../../../src/shared/settings-schema'
import type { ChatPage } from './workspace-worker-protocol'

type Header = {
  id: string
  title: string
  model: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** Runs in the chat worker. Legacy transcripts remain untouched after import. */
export class ChatDatabase {
  private db: DatabaseSync
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'chats.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, messageCount INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_recency ON conversations(updatedAt DESC);
      CREATE TABLE IF NOT EXISTS messages (
        threadId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(threadId, ordinal)
      );
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS message_identity ON messages(threadId, id);
    `)
    try {
      this.importLegacy(dir)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close(): void {
    this.db.close()
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private importLegacy(dir: string): void {
    if (this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get('legacy-json')) return
    const failures: string[] = []
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) continue
      try {
        const thread = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ChatThread
        if (!thread.id || !Array.isArray(thread.messages)) throw new Error('Invalid transcript')
        this.transaction(() => {
          // A previously imported conversation may already contain newer work.
          if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(thread.id))
            this.write(thread, true)
          this.db.prepare('INSERT INTO migrations(name) VALUES (?)').run(name)
        })
      } catch {
        failures.push(name)
      }
    }
    if (failures.length)
      throw new Error(
        `Chat import could not read ${failures.join(', ')}. Original JSON files are preserved.`
      )
    this.db.prepare('INSERT INTO migrations(name) VALUES (?)').run('legacy-json')
  }
  list(): ChatThread[] {
    return (
      this.db.prepare('SELECT * FROM conversations ORDER BY updatedAt DESC').all() as Header[]
    ).map((header) => ({ ...header, messages: [], messageOffset: header.messageCount }))
  }
  get(id: string, page?: ChatPage): ChatThread | null {
    const header = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      Header | undefined
    if (!header) return null
    const end = Math.max(
      0,
      Math.min(header.messageCount, Math.floor(page?.before ?? header.messageCount))
    )
    const limit =
      page?.limit === undefined
        ? header.messageCount
        : Math.max(1, Math.min(500, Math.floor(page.limit)))
    const start = Math.max(0, end - limit)
    const rows = this.db
      .prepare(
        'SELECT body FROM messages WHERE threadId = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal'
      )
      .all(id, start, end)
    return {
      ...header,
      messages: rows.map((row) => JSON.parse(String(row.body))),
      messageOffset: start
    }
  }
  private write(thread: ChatThread, preserveTime = false): ChatThread {
    const previous = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(thread.id) as
      Header | undefined
    const offset = thread.messageOffset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (previous?.messageCount ?? 0))
      throw new Error('Invalid chat page offset')
    const title =
      !thread.title || thread.title === 'New chat'
        ? previous?.title && previous.title !== 'New chat'
          ? previous.title
          : thread.messages
              .find((message) => message.role === 'user')
              ?.content.slice(0, 48)
              .replace(/\s+/g, ' ') || 'New chat'
        : thread.title
    const next = {
      ...thread,
      title,
      updatedAt: preserveTime ? thread.updatedAt : Date.now(),
      messageOffset: offset,
      messageCount: offset + thread.messages.length
    }
    this.db
      .prepare(
        `INSERT INTO conversations(id,title,model,createdAt,updatedAt,messageCount) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,model=excluded.model,updatedAt=excluded.updatedAt,messageCount=excluded.messageCount`
      )
      .run(next.id, title, next.model, next.createdAt, next.updatedAt, next.messageCount)
    const put = this.db.prepare(`INSERT INTO messages(threadId,ordinal,id,body) VALUES (?,?,?,?)
      ON CONFLICT(threadId,ordinal) DO UPDATE SET id=excluded.id,body=excluded.body WHERE messages.body != excluded.body`)
    for (const [index, message] of next.messages.entries())
      put.run(next.id, offset + index, message.id, JSON.stringify(message))
    this.db
      .prepare('DELETE FROM messages WHERE threadId = ? AND ordinal >= ?')
      .run(next.id, next.messageCount)
    return next
  }
  save(thread: ChatThread): ChatThread {
    return this.transaction(() => this.write(thread))
  }
  append(id: string, message: ChatMessage, model?: string): ChatThread {
    return this.transaction(() => {
      const header = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        Header | undefined
      if (!header) throw new Error('Chat not found')
      if (
        this.db.prepare('SELECT 1 FROM messages WHERE threadId = ? AND id = ?').get(id, message.id)
      )
        return this.get(id, { limit: 60 })!
      this.db
        .prepare('INSERT INTO messages(threadId,ordinal,id,body) VALUES (?,?,?,?)')
        .run(id, header.messageCount, message.id, JSON.stringify(message))
      const title =
        header.title === 'New chat' && message.role === 'user'
          ? message.content.slice(0, 48).replace(/\s+/g, ' ')
          : header.title
      this.db
        .prepare(
          'UPDATE conversations SET messageCount = messageCount + 1, updatedAt = ?, title = ?, model = ? WHERE id = ?'
        )
        .run(Date.now(), title, model ?? header.model, id)
      return this.get(id, { limit: 60 })!
    })
  }
  remove(id: string): boolean {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return true
  }
}

const databases = new Map<string, ChatDatabase>()
export function closeChatDatabases(): void {
  for (const database of databases.values()) database.close()
  databases.clear()
}
export function chatDatabase(dir: string): ChatDatabase {
  let database = databases.get(dir)
  if (!database) {
    // Opening the DB creates its directory; no full transcript reads on later opens.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    database = new ChatDatabase(dir)
    databases.set(dir, database)
    if (databases.size > 8) {
      const oldest = databases.keys().next().value!
      databases.get(oldest)?.close()
      databases.delete(oldest)
    }
  }
  return database
}
