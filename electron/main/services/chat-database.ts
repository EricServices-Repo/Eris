import {
  emptyMemoryControls,
  MemoryControlsSchema,
  type MemoryControls,
  type ContextHeader,
  type ContextPage
} from '../../../src/shared/context-memory'
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
  contextRevision: number
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
      CREATE TABLE IF NOT EXISTS context_source_epochs (
        threadId TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        epoch TEXT NOT NULL
      );
    `)
    this.transaction(() => {
      if (
        !(
          this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
        ).some((c) => c.name === 'contextRevision')
      )
        this.db.exec(
          'ALTER TABLE conversations ADD COLUMN contextRevision INTEGER NOT NULL DEFAULT 0'
        )
    })
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS context_controls(threadId TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,body TEXT NOT NULL)'
    )
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
          this.db.prepare('INSERT OR IGNORE INTO migrations(name) VALUES (?)').run(name)
        })
      } catch {
        failures.push(name)
      }
    }
    if (failures.length)
      throw new Error(
        `Chat import could not read ${failures.join(', ')}. Original JSON files are preserved.`
      )
    this.db.prepare('INSERT OR IGNORE INTO migrations(name) VALUES (?)').run('legacy-json')
  }
  private sourceEpoch(id: string): string {
    const known = this.db
      .prepare('SELECT epoch FROM context_source_epochs WHERE threadId=?')
      .get(id)
    if (known) return String(known.epoch)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO context_source_epochs(threadId,epoch) SELECT id,lower(hex(randomblob(16))) FROM conversations WHERE id=?'
      )
      .run(id)
    const row = this.db.prepare('SELECT epoch FROM context_source_epochs WHERE threadId=?').get(id)
    if (!row) throw new Error('Chat not found')
    return String(row.epoch)
  }
  contextHeader(id: string): ContextHeader | null {
    const header = this.db
      .prepare('SELECT contextRevision,messageCount FROM conversations WHERE id=?')
      .get(id)
    if (!header) return null
    return {
      revision: Number(header.contextRevision),
      messageCount: Number(header.messageCount),
      sourceEpoch: this.sourceEpoch(id)
    }
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
    Object.assign(header, { contextEpoch: this.sourceEpoch(id) })
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
      contextRevision: (previous?.contextRevision ?? 0) + 1,
      messageCount: offset + thread.messages.length
    }
    this.db
      .prepare(
        `INSERT INTO conversations(id,title,model,createdAt,updatedAt,messageCount,contextRevision) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,model=excluded.model,updatedAt=excluded.updatedAt,messageCount=excluded.messageCount,contextRevision=excluded.contextRevision`
      )
      .run(
        next.id,
        title,
        next.model,
        next.createdAt,
        next.updatedAt,
        next.messageCount,
        next.contextRevision
      )
    const put = this.db.prepare(`INSERT INTO messages(threadId,ordinal,id,body) VALUES (?,?,?,?)
      ON CONFLICT(threadId,ordinal) DO UPDATE SET id=excluded.id,body=excluded.body WHERE messages.body != excluded.body`)
    for (const [index, message] of next.messages.entries())
      put.run(next.id, offset + index, message.id, JSON.stringify(message))
    this.db
      .prepare('DELETE FROM messages WHERE threadId = ? AND ordinal >= ?')
      .run(next.id, next.messageCount)
    return { ...next, contextEpoch: this.sourceEpoch(next.id) }
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
          'UPDATE conversations SET messageCount = messageCount + 1, contextRevision = contextRevision + 1, updatedAt = ?, title = ?, model = ? WHERE id = ?'
        )
        .run(Date.now(), title, model ?? header.model, id)
      return this.get(id, { limit: 60 })!
    })
  }
  contextPage(id: string, before?: number, maxBytes = 2000000): ContextPage | null {
    this.db.exec('BEGIN')
    try {
      const page = this.readContextPage(id, before, maxBytes)
      this.db.exec('COMMIT')
      return page
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private readContextPage(id: string, before?: number, maxBytes = 2000000): ContextPage | null {
    const header = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as
      Header | undefined
    if (!header) return null
    const end = Math.max(0, Math.min(header.messageCount, before ?? header.messageCount)),
      records: ContextPage['records'] = []
    let bytes = 0,
      cursor = end,
      omitted = 0
    // Bound each transfer independently of huge archived messages. Oversize rows advance coverage explicitly.
    for (const row of this.db
      .prepare(
        'SELECT ordinal,CASE WHEN length(CAST(body AS BLOB))<=? THEN body ELSE NULL END AS body FROM messages WHERE threadId=? AND ordinal<? ORDER BY ordinal DESC LIMIT 500'
      )
      .iterate(maxBytes, id, end)) {
      const body = row.body === null ? null : String(row.body)
      if (body && bytes + Buffer.byteLength(body) > maxBytes && records.length) break
      cursor = Number(row.ordinal)
      if (!body) {
        omitted++
        continue
      }
      bytes += Buffer.byteLength(body)
      const message = JSON.parse(body)
      // Model reasoning traces and asset payloads are not context-history entries.
      records.push({
        ordinal: cursor,
        message: {
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          agentId: message.agentId,
          agentName: message.agentName,
          model: message.model,
          contextResult: message.contextResult
        }
      })
    }
    return {
      revision: header.contextRevision,
      sourceEpoch: this.sourceEpoch(id),
      messageCount: header.messageCount,
      before: cursor,
      done: cursor === 0,
      records: records.reverse(),
      omitted
    }
  }
  memoryControls(id: string, write?: MemoryControls): MemoryControls {
    if (write) write = MemoryControlsSchema.parse(write)
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))
      throw new Error('Chat not found')
    if (write)
      this.db
        .prepare(
          'INSERT INTO context_controls(threadId,body) VALUES (?,?) ON CONFLICT(threadId) DO UPDATE SET body=excluded.body'
        )
        .run(id, JSON.stringify(write))
    const row = this.db.prepare('SELECT body FROM context_controls WHERE threadId=?').get(id)
    if (!row) return emptyMemoryControls()
    return MemoryControlsSchema.parse(JSON.parse(String(row.body)))
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
