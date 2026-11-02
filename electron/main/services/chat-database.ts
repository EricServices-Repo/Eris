import { createHash as referenceHash } from 'crypto'
import { extractRecommendations } from '../../../src/shared/recommendations'
import type { ReferenceSource, ReferenceSourceResult } from '../../../src/shared/reference-binding'
import {
  installArchiveIndex,
  advanceArchiveIndex,
  archiveCandidates
} from './context-archive-index'
import {
  installContextChangeLog,
  replayContextChanges,
  contextDerivationStatus
} from './context-change-log'
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
import {
  installJournalStore,
  purgeJournal,
  readJournal,
  searchJournal,
  writeJournalEntry
} from './context-journal-store'
import type { DurableJournalEntry } from '../../../src/shared/context-journal'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
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
/**
 * Identity of the physical database file. SQLite content, including thread IDs and
 * stored source epochs, travels with a copy, so only the file itself can tell a
 * replacement from the database a cached snapshot was read from.
 */
function databaseFileIdentity(path: string): string | null {
  try {
    const file = statSync(path, { bigint: true })
    return createHash('sha256')
      .update(`${file.dev}:${file.ino}:${file.birthtimeNs}`)
      .digest('hex')
      .slice(0, 16)
  } catch {
    return null
  }
}
function storageUsage(
  db: DatabaseSync,
  file: string
): import('../../../src/shared/memory-usage').ArchiveMemoryUsage {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS conversations, COALESCE(SUM(messageCount), 0) AS messages FROM conversations'
    )
    .get() as { conversations: number; messages: number }
  const size = (path: string) => {
    try {
      return statSync(path).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }
  return {
    initialized: true,
    ...row,
    databaseBytes: size(file),
    journalBytes: size(`${file}-wal`) + size(`${file}-shm`)
  }
}
/** Metadata-only read: never creates, migrates, imports or hydrates chat history. */
export function chatStorageUsage(
  dir: string
): import('../../../src/shared/memory-usage').ArchiveMemoryUsage {
  const file = join(dir, 'chats.sqlite')
  if (!existsSync(file))
    return { initialized: false, conversations: 0, messages: 0, databaseBytes: 0, journalBytes: 0 }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return storageUsage(db, file)
  } finally {
    db.close()
  }
}
export class ChatDatabase {
  storageUsage() {
    return storageUsage(this.db, this.file)
  }
  private db: DatabaseSync
  private readonly file: string
  private readonly incarnation: string
  private readonly journal: string | null
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'chats.sqlite')
    this.db = new DatabaseSync(this.file)
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
    this.incarnation = databaseFileIdentity(this.file) ?? ''
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
    this.transaction(() => installArchiveIndex(this.db))
    this.transaction(() => installJournalStore(this.db))
    this.migrateContextSequences()
    this.transaction(() => installContextChangeLog(this.db))
    try {
      this.importLegacy(dir)
    } catch (error) {
      this.db.close()
      throw error
    }
    this.journal = databaseFileIdentity(`${this.file}-wal`)
  }
  /** True once this handle no longer reads the file at its path. */
  replaced(): boolean {
    return databaseFileIdentity(this.file) !== this.incarnation
  }
  /**
   * SQLite will not checkpoint a moved database, and would replay the WAL left behind
   * onto the file now at this path. A journal delivered with the replacement stays.
   */
  retire(): void {
    this.close()
    if (this.journal === null || databaseFileIdentity(`${this.file}-wal`) !== this.journal) return
    rmSync(`${this.file}-wal`, { force: true })
    rmSync(`${this.file}-shm`, { force: true })
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
    return `${this.incarnation}:${this.threadEpoch(id)}`
  }
  private threadEpoch(id: string): string {
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
  replayContextChanges(limit = 128) {
    return this.transaction(() =>
      replayContextChanges(this.db, limit, (id) => {
        if (this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))
          purgeJournal(this.db, id, this.memoryControls(id))
      })
    )
  }
  contextChangeStatus() {
    return contextDerivationStatus(this.db)
  }
  contextChanges(after = 0, limit = 128) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid context change cursor')
    return {
      status: this.contextChangeStatus(),
      capabilities: this.contextCapabilities(),
      events: this.db
        .prepare('SELECT * FROM context_changes WHERE sequence>? ORDER BY sequence LIMIT ?')
        .all(after, limit)
    }
  }
  contextCapabilities() {
    return {
      journal: String(this.db.prepare('PRAGMA journal_mode').get()!.journal_mode),
      fts5: Boolean(
        this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS supported").get()!
          .supported
      )
    }
  }
  contextHeader(id: string): ContextHeader | null {
    const header = this.db
      .prepare(
        `SELECT c.contextRevision,c.messageCount,s.epoch,CASE WHEN k.body IS NULL THEN 0 WHEN json_valid(k.body) THEN COALESCE(json_extract(k.body,'$.revision'),0) ELSE -1 END AS controlsRevision FROM conversations c LEFT JOIN context_controls k ON k.threadId=c.id LEFT JOIN context_source_epochs s ON s.threadId=c.id WHERE c.id=?`
      )
      .get(id)
    if (!header) return null
    return {
      controlsRevision: Number(header.controlsRevision),
      derivation: this.contextChangeStatus(),
      revision: Number(header.contextRevision),
      messageCount: Number(header.messageCount),
      sourceEpoch: `${this.incarnation}:${String(header.epoch)}`
    }
  }
  /** Indexed source-ID lookups only; never hydrate the intervening transcript. */
  referenceSources(id: string, sources: ReferenceSource[]): ReferenceSourceResult {
    if (
      sources.length > 64 ||
      sources.some((source) => source.messageId.length > 256 || source.items.length > 100)
    )
      throw new Error('Reference source budget exceeded')
    if (!this.contextHeader(id)) return { sourceVersion: null, sources: [] }
    this.contextControls(id) // Bind any legacy cutoff before opening the source snapshot.
    return this.transaction(() => {
      const header = this.contextHeader(id)
      const raw = this.db.prepare('SELECT body FROM context_controls WHERE threadId=?').get(id)
      const controls = raw
        ? MemoryControlsSchema.parse(JSON.parse(String(raw.body)))
        : emptyMemoryControls()
      const forgotten = new Set(controls.forgotten)
      const found: ReferenceSourceResult['sources'] = []
      let bytes = 0
      for (const source of sources) {
        if (forgotten.has(source.messageId)) continue
        const row = this.db
          .prepare(
            `SELECT ordinal,contextSequence,
          json_extract(body,'$.content') AS content,
          json_extract(body,'$.contextResult.projectRoot') AS projectRoot
          FROM messages WHERE threadId=? AND id=? AND json_valid(body)
          AND json_extract(body,'$.role')='assistant'
          AND length(json_extract(body,'$.content'))<=65536 LIMIT 1`
          )
          .get(id, source.messageId)
        if (
          !row ||
          (controls.afterSequence !== undefined
            ? Number(row.contextSequence) <= controls.afterSequence
            : Number(row.ordinal) < controls.afterOrdinal)
        )
          continue
        const projectRoot = row.projectRoot === null ? null : String(row.projectRoot)
        if (projectRoot !== source.projectRoot) continue
        const recommendations = extractRecommendations(String(row.content))
          .slice(0, 100)
          .filter(
            (item) =>
              !forgotten.has(item.id) &&
              source.items.some(
                (expected) =>
                  expected.id === item.id &&
                  expected.digest ===
                    referenceHash('sha256')
                      .update(
                        JSON.stringify([item.id, item.text, item.targets ?? [], item.section ?? ''])
                      )
                      .digest('hex')
              )
          )
        const result = { messageId: source.messageId, projectRoot, recommendations }
        bytes += Buffer.byteLength(JSON.stringify(result))
        if (bytes > 1024 ** 2) break
        found.push(result)
      }
      return { sourceVersion: header, sources: found }
    })
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
    return this.transaction(() => {
      const saved = this.write(thread)
      purgeJournal(this.db, thread.id, this.memoryControls(thread.id))
      return saved
    })
  }
  journalWrite(id: string, entry: DurableJournalEntry, maxBytes: number) {
    return this.transaction(() => writeJournalEntry(this.db, id, entry, maxBytes))
  }
  journalSearch(id: string, query: string, limit: number, projectRoot?: string | null) {
    return searchJournal(this.db, id, query, limit, this.contextControls(id), projectRoot)
  }
  journalRead(id: string, ref: string, projectRoot?: string | null) {
    return readJournal(this.db, id, ref, this.contextControls(id), projectRoot)
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
  scopeContextSource(id: string, messageId: string, projectRoot: string | null): boolean {
    return this.transaction(() => {
      const updated = this.db
        .prepare(
          "UPDATE messages SET body=json_set(body,'$.contextProjectRoot',?) WHERE threadId=? AND id=? AND json_valid(body) AND json_extract(body,'$.role')='user' AND json_extract(body,'$.contextProjectRoot') IS NOT ?"
        )
        .run(projectRoot, id, messageId, projectRoot)
      if (updated.changes)
        this.db
          .prepare('UPDATE conversations SET contextRevision=contextRevision+1 WHERE id=?')
          .run(id)
      return Boolean(updated.changes)
    })
  }
  archiveSearch(
    id: string,
    query: string,
    projectRoot?: string | null
  ): import('../../../src/shared/archive-context').ArchiveContextSearch {
    return this.transaction(() => {
      const header = this.contextHeader(id)
      if (!header)
        return {
          header: null,
          records: [],
          index: {
            version: 1,
            backend: 'sqlite-postings',
            fts5Available: this.contextCapabilities().fts5,
            builtChunks: 0,
            complete: true,
            cursor: 0,
            contentOffset: 0,
            candidates: 0
          }
        }
      this.bindLegacyCutoff(id)
      const controls = this.memoryControls(id)
      const index = advanceArchiveIndex(this.db, id)
      const candidates = archiveCandidates(this.db, id, query)
      const records: ContextPage['records'] = []
      const seen = new Set<string>()
      for (const row of candidates) {
        const raw = this.db
          .prepare(
            `SELECT contextSequence,CASE WHEN json_valid(body) AND length(json_extract(body,'$.id'))<=1024 AND coalesce(length(json_extract(body,'$.contextProjectRoot')),0)<=4096 AND coalesce(length(CAST(json_extract(body,'$.contextResult') AS BLOB)),0)<=16384 THEN json_object(
          'id',substr(json_extract(body,'$.id'),1,1024), 'role',json_extract(body,'$.role'),
          'content',substr(json_extract(body,'$.content'),?,2048), 'createdAt',coalesce(json_extract(body,'$.createdAt'),0),
          'contextProjectRoot',json_extract(body,'$.contextProjectRoot'),
          'contextResult',CASE WHEN length(CAST(json_extract(body,'$.contextResult') AS BLOB))<=16384 THEN json_extract(body,'$.contextResult') END) END AS body
          FROM messages WHERE threadId=? AND ordinal=?`
          )
          .get(Number(row.offset) + 1, id, row.ordinal!)
        if (!raw || Number(raw.contextSequence) !== Number(row.sequence) || !raw.body) continue
        const value = JSON.parse(String(raw.body))
        if (value.contextResult === null) delete value.contextResult
        if (value.contextProjectRoot === null) delete value.contextProjectRoot
        const message = contextRecord({
          ...value,
          contextSequence: Number(raw.contextSequence),
          contextContentOffset: Number(row.offset)
        })
        if (
          !message ||
          message.content !== row.text ||
          message.role === 'system' ||
          seen.has(message.id) ||
          controls.forgotten.includes(message.id) ||
          (controls.afterSequence !== undefined
            ? Number(raw.contextSequence) <= controls.afterSequence
            : Number(row.ordinal) < controls.afterOrdinal) ||
          (projectRoot !== undefined &&
            ((message.contextProjectRoot !== undefined &&
              message.contextProjectRoot !== projectRoot) ||
              (message.contextResult?.projectRoot !== undefined &&
                message.contextResult.projectRoot !== projectRoot)))
        )
          continue
        seen.add(message.id)
        records.push({ ordinal: Number(row.ordinal), message, terms: recallTerms(message.content) })
        if (records.length >= 12) break
      }
      return {
        header: this.contextHeader(id),
        records: records.sort((a, b) => a.ordinal - b.ordinal),
        index: { ...index, candidates: candidates.length }
      }
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
      'contextProjectRoot',json_extract(body,'$.contextProjectRoot'),
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
        for (const optional of [
          'agentId',
          'agentName',
          'model',
          'contextResult',
          'contextProjectRoot'
        ])
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
      purgeJournal(this.db, id, committedPayload)
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
export function closeChatDatabase(dir: string): boolean {
  databases.get(dir)?.close()
  return databases.delete(dir)
}
export function closeChatDatabases(): void {
  for (const database of databases.values()) database.close()
  databases.clear()
}
export function chatDatabase(dir: string): ChatDatabase {
  let database = databases.get(dir)
  if (database?.replaced()) {
    // Never keep serving, or writing to, a file that left this path.
    database.retire()
    databases.delete(dir)
    database = undefined
  }
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
