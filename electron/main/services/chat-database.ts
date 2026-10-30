import { contextRecord } from '../../../src/shared/context-record'
import { recallTerms } from '../../../src/shared/recall-terms'
import {
  emptyMemoryControls,
  MemoryControlsSchema,
  CONTEXT_CONTROLS_CONFLICT,
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
  contextSequence: number
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
    this.migrateContextSequences()
    try {
      this.importLegacy(dir)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  private migrateContextSequences(): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('context-sequence-v1'))
        return
      for (const table of ['conversations', 'messages']) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
        }>
        if (!columns.some((c) => c.name === 'contextSequence'))
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN contextSequence INTEGER NOT NULL DEFAULT 0`)
      }
      this.db.exec(`UPDATE messages SET contextSequence=ordinal+1 WHERE contextSequence=0;
        UPDATE conversations SET contextSequence=MAX(contextSequence,COALESCE((SELECT MAX(contextSequence) FROM messages WHERE threadId=conversations.id),0));`)
      for (const row of this.db.prepare('SELECT threadId FROM context_controls').all())
        this.bindLegacyCutoff(String(row.threadId))
      this.db.prepare('INSERT INTO migrations(name) VALUES (?)').run('context-sequence-v1')
    })
  }
  private cutoffSequence(id: string, ordinal: number): number {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(contextSequence),0) AS sequence FROM messages WHERE threadId=? AND ordinal<?'
        )
        .get(id, ordinal)?.sequence ?? 0
    )
  }
  private bindLegacyCutoff(id: string): void {
    const row = this.db.prepare('SELECT body FROM context_controls WHERE threadId=?').get(id)
    if (!row) return
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(String(row.body))
    } catch {
      return
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !Number.isSafeInteger(raw.afterOrdinal) ||
      Number(raw.afterOrdinal) < 0
    )
      return
    if (raw.afterSequence !== undefined) return
    raw.afterSequence = this.cutoffSequence(id, Number(raw.afterOrdinal ?? 0))
    // Preserve the optimistic concurrency contract if it is present in this database.
    if (typeof raw.revision === 'number') raw.revision++
    this.db
      .prepare('UPDATE context_controls SET body=? WHERE threadId=?')
      .run(JSON.stringify(raw), id)
  }
  /** Bind legacy ordinal cutoffs once while the canonical snapshot is locked. */
  contextControls(
    id: string,
    write?: MemoryControls,
    expectedSource?: ContextHeader
  ): MemoryControls {
    return this.transaction(() => {
      if (expectedSource) {
        const current = this.contextHeader(id)
        if (
          !current ||
          current.revision !== expectedSource.revision ||
          current.messageCount !== expectedSource.messageCount ||
          current.sourceEpoch !== expectedSource.sourceEpoch
        )
          throw new Error(
            'STALE_CONTEXT_INSPECTION: Conversation changed. Reopen conversation memory before editing controls.'
          )
      }
      this.bindLegacyCutoff(id)
      if (write) {
        const parsed = MemoryControlsSchema.parse(write)
        const maximum = Number(
          this.db.prepare('SELECT contextSequence FROM conversations WHERE id=?').get(id)
            ?.contextSequence ?? 0
        )
        return this.memoryControls(id, {
          ...parsed,
          afterSequence:
            parsed.afterSequence === undefined
              ? this.cutoffSequence(id, parsed.afterOrdinal)
              : Math.min(maximum, parsed.afterSequence)
        })
      }
      return this.memoryControls(id)
    })
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
        'SELECT body,contextSequence FROM messages WHERE threadId = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal'
      )
      .all(id, start, end)
    return {
      ...header,
      messages: rows.map((row) => ({
        ...JSON.parse(String(row.body)),
        contextSequence: Number(row.contextSequence)
      })),
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
    this.bindLegacyCutoff(thread.id)
    let sequence = previous?.contextSequence ?? 0
    const prepared = thread.messages.map((message, index) => {
      const prior = this.db
        .prepare('SELECT id,body,contextSequence FROM messages WHERE threadId=? AND ordinal=?')
        .get(thread.id, offset + index)
      let unchanged = false
      if (prior && prior.id === message.id) {
        const old = JSON.parse(String(prior.body)) as ChatMessage
        unchanged = old.role === message.role && old.content === message.content
      }
      const sourceSequence = unchanged ? Number(prior!.contextSequence) : ++sequence
      sequence = Math.max(sequence, sourceSequence)
      const { contextSequence: _clientSequence, ...canonical } = message
      return {
        message: { ...canonical, contextSequence: sourceSequence },
        body: JSON.stringify(canonical),
        sequence: sourceSequence
      }
    })
    const next = {
      ...thread,
      messages: prepared.map((row) => row.message),
      contextSequence: sequence,
      title,
      updatedAt: preserveTime ? thread.updatedAt : Date.now(),
      messageOffset: offset,
      contextRevision: (previous?.contextRevision ?? 0) + 1,
      messageCount: offset + thread.messages.length
    }
    this.db
      .prepare(
        `INSERT INTO conversations(id,title,model,createdAt,updatedAt,messageCount,contextRevision,contextSequence) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,model=excluded.model,updatedAt=excluded.updatedAt,messageCount=excluded.messageCount,contextRevision=excluded.contextRevision,contextSequence=excluded.contextSequence`
      )
      .run(
        next.id,
        title,
        next.model,
        next.createdAt,
        next.updatedAt,
        next.messageCount,
        next.contextRevision,
        next.contextSequence
      )
    const put = this.db
      .prepare(`INSERT INTO messages(threadId,ordinal,id,body,contextSequence) VALUES (?,?,?,?,?)
      ON CONFLICT(threadId,ordinal) DO UPDATE SET id=excluded.id,body=excluded.body,contextSequence=excluded.contextSequence WHERE messages.body != excluded.body`)
    for (const [index, row] of prepared.entries())
      put.run(next.id, offset + index, row.message.id, row.body, row.sequence)
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
        .prepare(
          'INSERT INTO messages(threadId,ordinal,id,body,contextSequence) VALUES (?,?,?,?,?)'
        )
        .run(
          id,
          header.messageCount,
          message.id,
          JSON.stringify({ ...message, contextSequence: undefined }),
          header.contextSequence + 1
        )
      const title =
        header.title === 'New chat' && message.role === 'user'
          ? message.content.slice(0, 48).replace(/\s+/g, ' ')
          : header.title
      this.db
        .prepare(
          'UPDATE conversations SET messageCount = messageCount + 1, contextRevision = contextRevision + 1, contextSequence=contextSequence+1, updatedAt = ?, title = ?, model = ? WHERE id = ?'
        )
        .run(Date.now(), title, model ?? header.model, id)
      return this.get(id, { limit: 60 })!
    })
  }
  contextPage(
    id: string,
    before?: number,
    maxBytes = 2000000,
    beforeContentOffset?: number
  ): ContextPage | null {
    this.db.exec('BEGIN')
    try {
      const page = this.readContextPage(id, before, maxBytes, beforeContentOffset)
      this.db.exec('COMMIT')
      return page
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private readContextPage(
    id: string,
    before?: number,
    maxBytes = 2000000,
    beforeContentOffset?: number
  ): ContextPage | null {
    const header = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as
      Header | undefined
    if (!header) return null
    const end = Math.max(0, Math.min(header.messageCount, before ?? header.messageCount)),
      records: ContextPage['records'] = []
    let bytes = 0,
      cursor = end,
      omitted = 0,
      corruptRecords = 0
    const corruptOrdinals: number[] = []
    // SQLite parses the canonical JSON inside the worker. Only a normalized,
    // bounded content projection crosses into JS/IPC; traces/assets never do.
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 2000000)
      throw new Error('Context page byte cap must be between 512 and 2000000')
    if (
      beforeContentOffset !== undefined &&
      (!Number.isSafeInteger(beforeContentOffset) || beforeContentOffset <= 0)
    )
      throw new Error('Invalid context content cursor')
    const rowEnd = beforeContentOffset === undefined ? end - 1 : end
    const text = "json_extract(body,'$.content')"
    const contentEnd = `min(length(${text}), CASE WHEN ordinal=$end THEN coalesce($offset,length(${text})) ELSE length(${text}) END)`
    const contentStart = `max(0,${contentEnd}-$chunk)`
    const bounded = (field: string, cap: number) =>
      `CASE WHEN length(CAST(json_extract(body,'$.${field}') AS BLOB))<=${cap} THEN json_extract(body,'$.${field}') ELSE NULL END`
    const projection = `CASE WHEN json_valid(body) THEN CASE WHEN json_type(body,'$.content')='text' THEN json_object(
      'id',${bounded('id', 1024)},'role',${bounded('role', 64)},
      'content',substr(${text},${contentStart}+1,${contentEnd}-${contentStart}),
      'createdAt',CASE WHEN json_type(body,'$.createdAt') IS NULL THEN 0 WHEN json_type(body,'$.createdAt') IN ('integer','real') THEN json_extract(body,'$.createdAt') ELSE NULL END,
      'agentId',${bounded('agentId', 1024)},'agentName',${bounded('agentName', 2048)},'model',${bounded('model', 2048)},
      'contextResult',CASE WHEN length(CAST(json_extract(body,'$.contextResult') AS BLOB))<=$receipt THEN json_extract(body,'$.contextResult') ELSE NULL END,
      'contextContentOffset',${contentStart},'contextContentLength',length(${text})
    ) ELSE NULL END ELSE NULL END`
    let nextContentOffset: number | undefined,
      metadataOmitted = 0
    for (const row of this.db
      .prepare(
        `SELECT ordinal,contextSequence,${projection} AS body,
      CASE WHEN json_valid(body) THEN length(CAST(json_extract(body,'$.contextResult') AS BLOB))>$receipt ELSE 0 END AS metadataOmitted
      FROM messages WHERE threadId=$id AND ordinal<=$end ORDER BY ordinal DESC LIMIT 500`
      )
      .iterate({
        $id: id,
        $end: rowEnd,
        $offset: beforeContentOffset ?? null,
        $chunk: Math.max(1, Math.min(32768, Math.floor(maxBytes / 12))),
        $receipt: Math.min(65536, Math.floor(maxBytes / 8))
      })) {
      const body = row.body === null ? null : String(row.body)
      if (body && bytes + Buffer.byteLength(body) > maxBytes && records.length) break
      cursor = Number(row.ordinal)
      if (!body || Buffer.byteLength(body) > maxBytes) {
        omitted++
        if (!body) {
          corruptRecords++
          corruptOrdinals.push(cursor)
        }
        continue
      }
      bytes += Buffer.byteLength(body)
      let message: ChatMessage | null = null
      try {
        const value = JSON.parse(body)
        for (const optional of ['agentId', 'agentName', 'model', 'contextResult'])
          if (value[optional] === null) delete value[optional]
        if (
          value.contextContentOffset === 0 &&
          value.contextContentLength === [...value.content].length
        ) {
          delete value.contextContentOffset
          delete value.contextContentLength
        }
        message = contextRecord(value)
      } catch {
        /* Preserve corrupt JSON for repair. */
      }
      if (!message) {
        omitted++
        corruptRecords++
        corruptOrdinals.push(cursor)
        continue
      }
      metadataOmitted += Number(row.metadataOmitted ?? 0)
      records.push({
        ordinal: cursor,
        message: { ...message, contextSequence: Number(row.contextSequence) },
        terms: recallTerms(message.content)
      })
      if (message.contextContentOffset) {
        nextContentOffset = message.contextContentOffset
        break // Continue this source before advancing to the preceding ordinal.
      }
    }
    return {
      revision: header.contextRevision,
      sourceEpoch: this.sourceEpoch(id),
      messageCount: header.messageCount,
      before: cursor,
      done: cursor === 0 && nextContentOffset === undefined,
      beforeContentOffset: nextContentOffset,
      metadataOmitted,
      records: records.reverse(),
      omitted,
      corruptRecords,
      corruptOrdinals
    }
  }
  memoryControls(id: string, write?: MemoryControls): MemoryControls {
    if (write) write = MemoryControlsSchema.parse(write)
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))
      throw new Error('Chat not found')
    if (write) {
      const expectedRevision = write.revision ?? 0
      const committedPayload = MemoryControlsSchema.parse({
        ...write,
        revision: expectedRevision + 1
      })
      // One SQLite statement checks and writes under the writer lock. A stale
      // revision must never win even when callers use separate worker connections.
      const result = this.db
        .prepare(
          `
        INSERT INTO context_controls(threadId,body)
        SELECT ?,json_set(?, '$.revision',1)
        WHERE ?=0 OR EXISTS(SELECT 1 FROM context_controls WHERE threadId=?)
        ON CONFLICT(threadId) DO UPDATE SET body=json_set(excluded.body,'$.revision',
          COALESCE(json_extract(context_controls.body,'$.revision'),0)+1)
        WHERE COALESCE(json_extract(context_controls.body,'$.revision'),0)=?
      `
        )
        .run(id, JSON.stringify(committedPayload), expectedRevision, id, expectedRevision)
      if (Number(result.changes) === 0) {
        const current = this.memoryControls(id)
        const { revision: _requestedRevision, ...requested } = write
        const { revision: _currentRevision, ...saved } = current
        if (JSON.stringify(requested) === JSON.stringify(saved)) return current // idempotent retry
        throw new Error(
          `${CONTEXT_CONTROLS_CONFLICT}: Memory controls changed in another view. Reload RAM from saved history, then retry your action.`
        )
      }
    }
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
