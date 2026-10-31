import type { DatabaseSync } from 'node:sqlite'
import { recallTerms, queryTerms, recallQuery } from '../../../src/shared/recall-terms'
/** Worker-only, resumable bounded chunks. Canonical messages remain the source of truth. */
export function installArchiveIndex(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_archive_chunks (
    chunkId INTEGER PRIMARY KEY, threadId TEXT NOT NULL, ordinal INTEGER NOT NULL,
    offset INTEGER NOT NULL, text TEXT NOT NULL, sequence INTEGER NOT NULL,
    UNIQUE(threadId,ordinal,offset));
    CREATE INDEX IF NOT EXISTS context_archive_source ON context_archive_chunks(threadId,ordinal);
    CREATE TABLE IF NOT EXISTS context_archive_terms (
      threadId TEXT NOT NULL, term TEXT NOT NULL, chunkId INTEGER NOT NULL REFERENCES context_archive_chunks(chunkId) ON DELETE CASCADE,
      PRIMARY KEY(threadId,term,chunkId));
    CREATE TABLE IF NOT EXISTS context_archive_cursor(threadId TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS context_archive_dirty(threadId TEXT NOT NULL,ordinal INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(threadId,ordinal));
    CREATE TRIGGER IF NOT EXISTS context_archive_insert AFTER INSERT ON messages BEGIN
      INSERT OR IGNORE INTO context_archive_dirty(threadId,ordinal) VALUES(NEW.threadId,NEW.ordinal); END;
    CREATE TRIGGER IF NOT EXISTS context_archive_update AFTER UPDATE OF body,contextSequence ON messages BEGIN
      DELETE FROM context_archive_chunks WHERE threadId=NEW.threadId AND ordinal=NEW.ordinal;
      INSERT INTO context_archive_dirty VALUES(NEW.threadId,NEW.ordinal,0) ON CONFLICT(threadId,ordinal) DO UPDATE SET offset=0; END;
    CREATE TRIGGER IF NOT EXISTS context_archive_delete AFTER DELETE ON messages BEGIN
      DELETE FROM context_archive_chunks WHERE threadId=OLD.threadId AND ordinal=OLD.ordinal;
      DELETE FROM context_archive_dirty WHERE threadId=OLD.threadId AND ordinal=OLD.ordinal; END;
    CREATE TRIGGER IF NOT EXISTS context_archive_thread_delete AFTER DELETE ON conversations BEGIN
      DELETE FROM context_archive_cursor WHERE threadId=OLD.id;
      DELETE FROM context_archive_chunks WHERE threadId=OLD.id;
      DELETE FROM context_archive_dirty WHERE threadId=OLD.id; END;`)
}
export function advanceArchiveIndex(db: DatabaseSync, id: string, limit = 32) {
  db.prepare('INSERT OR IGNORE INTO context_archive_cursor VALUES(?,0,0)').run(id)
  let builtChunks = 0
  for (; builtChunks < limit; builtChunks++) {
    const cursor = db
      .prepare('SELECT ordinal,offset FROM context_archive_cursor WHERE threadId=?')
      .get(id)!
    const dirty = db
      .prepare(
        'SELECT ordinal,offset FROM context_archive_dirty WHERE threadId=? ORDER BY ordinal LIMIT 1'
      )
      .get(id)
    const ordinal = Number(dirty?.ordinal ?? cursor.ordinal),
      offset = Number(dirty?.offset ?? cursor.offset)
    const row = db
      .prepare(
        `SELECT ordinal,contextSequence,
      CASE WHEN json_valid(body) AND json_type(body,'$.content')='text' THEN substr(json_extract(body,'$.content'),?,2048) END AS text,
      CASE WHEN json_valid(body) THEN length(json_extract(body,'$.content')) ELSE 0 END AS chars
      FROM messages WHERE threadId=? AND ordinal>=? ORDER BY ordinal LIMIT 1`
      )
      .get(offset + 1, id, ordinal)
    if (!row) {
      if (dirty) {
        db.prepare('DELETE FROM context_archive_dirty WHERE threadId=? AND ordinal=?').run(
          id,
          ordinal
        )
        continue
      }
      break
    }
    const actual = Number(row.ordinal),
      text = typeof row.text === 'string' ? row.text : ''
    if (text) {
      const chunk = db
        .prepare(
          'INSERT INTO context_archive_chunks(threadId,ordinal,offset,text,sequence) VALUES(?,?,?,?,?) ON CONFLICT(threadId,ordinal,offset) DO UPDATE SET text=excluded.text,sequence=excluded.sequence RETURNING chunkId'
        )
        .get(id, actual, offset, text, row.contextSequence!)!
      const chunkId = chunk.chunkId!
      db.prepare('DELETE FROM context_archive_terms WHERE chunkId=?').run(chunkId)
      const put = db.prepare('INSERT OR IGNORE INTO context_archive_terms VALUES(?,?,?)')
      for (const term of recallTerms(text)) put.run(id, term, chunkId)
    }
    const more = text && offset + 2048 < Number(row.chars)
    const nextOrdinal = more ? actual : actual + 1,
      nextOffset = more ? offset + 1920 : 0
    if (dirty) {
      if (more)
        db.prepare('UPDATE context_archive_dirty SET offset=? WHERE threadId=? AND ordinal=?').run(
          nextOffset,
          id,
          ordinal
        )
      else
        db.prepare('DELETE FROM context_archive_dirty WHERE threadId=? AND ordinal=?').run(
          id,
          ordinal
        )
    }
    if (!dirty || actual === Number(cursor.ordinal))
      db.prepare('UPDATE context_archive_cursor SET ordinal=?,offset=? WHERE threadId=?').run(
        nextOrdinal,
        nextOffset,
        id
      )
  }
  const cursor = db
    .prepare('SELECT ordinal,offset FROM context_archive_cursor WHERE threadId=?')
    .get(id)!
  const pending = Boolean(
    db.prepare('SELECT 1 FROM context_archive_dirty WHERE threadId=? LIMIT 1').get(id)
  )
  const remaining = Boolean(
    db
      .prepare('SELECT 1 FROM messages WHERE threadId=? AND ordinal>=? LIMIT 1')
      .get(id, cursor.ordinal!)
  )
  return {
    version: 1 as const,
    backend: 'sqlite-postings' as const,
    fts5Available: Boolean(
      db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS n").get()!.n
    ),
    builtChunks,
    complete: !pending && !remaining,
    cursor: Number(cursor.ordinal),
    contentOffset: Number(cursor.offset)
  }
}
export function archiveCandidates(db: DatabaseSync, id: string, query: string) {
  const terms = queryTerms(recallQuery(query.slice(0, 8192))).slice(0, 16)
  if (!terms.length) return []
  // Give every query term its own bounded posting slice. A common term must not
  // consume the entire arena before a rare identifier is considered.
  const slices = terms
    .map(
      () => `SELECT chunkId FROM (SELECT chunkId FROM context_archive_terms
    WHERE threadId=? AND term=? ORDER BY chunkId DESC LIMIT 256)`
    )
    .join(' UNION ALL ')
  return db
    .prepare(
      `SELECT c.* FROM context_archive_chunks c JOIN (
    SELECT chunkId,COUNT(*) AS score FROM (${slices})
    GROUP BY chunkId ORDER BY score DESC,chunkId DESC LIMIT 64
  ) hits ON hits.chunkId=c.chunkId ORDER BY hits.score DESC,c.ordinal DESC`
    )
    .all(...terms.flatMap((term) => [id, term]))
}
