import type { DatabaseSync } from 'node:sqlite'
import type { ContextDerivationStatus } from '../../../src/shared/context-memory'

/** Install under the caller's writer transaction. Triggers also cover independent SQLite writers. */
export function installContextChangeLog(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL,
      kind TEXT NOT NULL, timelineRevision INTEGER NOT NULL, controlsRevision INTEGER NOT NULL,
      sourceEpoch TEXT, at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS context_changes_thread ON context_changes(threadId,sequence);
    CREATE TABLE IF NOT EXISTS context_derivation_cursor (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO context_derivation_cursor VALUES(1,1,0);
    CREATE TABLE IF NOT EXISTS context_source_catalog (
      threadId TEXT PRIMARY KEY, timelineRevision INTEGER NOT NULL, controlsRevision INTEGER NOT NULL,
      sourceEpoch TEXT, sequence INTEGER NOT NULL, deleted INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS context_log_create AFTER INSERT ON conversations BEGIN
      INSERT OR IGNORE INTO context_source_epochs VALUES(NEW.id,lower(hex(randomblob(16))));
      INSERT INTO context_changes(threadId,kind,timelineRevision,controlsRevision,sourceEpoch)
        VALUES(NEW.id,'create',NEW.contextRevision,0,(SELECT epoch FROM context_source_epochs WHERE threadId=NEW.id));
    END;
    CREATE TRIGGER IF NOT EXISTS context_log_timeline AFTER UPDATE OF contextRevision ON conversations
      WHEN NEW.contextRevision != OLD.contextRevision BEGIN
      INSERT INTO context_changes(threadId,kind,timelineRevision,controlsRevision,sourceEpoch)
        VALUES(NEW.id,'timeline',NEW.contextRevision,COALESCE((SELECT json_extract(body,'$.revision') FROM context_controls WHERE threadId=NEW.id),0),
        (SELECT epoch FROM context_source_epochs WHERE threadId=NEW.id));
    END;
    CREATE TRIGGER IF NOT EXISTS context_log_delete AFTER DELETE ON conversations BEGIN
      INSERT INTO context_changes(threadId,kind,timelineRevision,controlsRevision,sourceEpoch)
        VALUES(OLD.id,'delete',OLD.contextRevision,0,NULL);
    END;
  `)
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW'
    db.exec(`CREATE TRIGGER IF NOT EXISTS context_log_controls_${operation.toLowerCase()} AFTER ${operation} ON context_controls BEGIN
      INSERT INTO context_changes(threadId,kind,timelineRevision,controlsRevision,sourceEpoch)
        VALUES(${row}.threadId,'controls',COALESCE((SELECT contextRevision FROM conversations WHERE id=${row}.threadId),0),
        COALESCE(json_extract(${row}.body,'$.revision'),0),(SELECT epoch FROM context_source_epochs WHERE threadId=${row}.threadId));
    END;`)
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE name=?').get('context-change-log-v1')) {
    db.exec(`INSERT OR IGNORE INTO context_source_epochs SELECT id,lower(hex(randomblob(16))) FROM conversations;
      INSERT INTO context_changes(threadId,kind,timelineRevision,controlsRevision,sourceEpoch)
        SELECT c.id,'backfill',c.contextRevision,COALESCE(json_extract(k.body,'$.revision'),0),s.epoch
        FROM conversations c LEFT JOIN context_controls k ON k.threadId=c.id JOIN context_source_epochs s ON s.threadId=c.id;
      INSERT INTO migrations(name) VALUES('context-change-log-v1');`)
  }
}

export function contextDerivationStatus(db: DatabaseSync): ContextDerivationStatus {
  const highWatermark = Number(
    db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM context_changes').get()!.n
  )
  const cursor = db
    .prepare('SELECT version,sequence FROM context_derivation_cursor WHERE id=1')
    .get()
  const watermark = cursor?.version === 1 ? Number(cursor.sequence) : 0
  return {
    version: 1,
    kind: 'source-catalog',
    watermark,
    highWatermark,
    pending: Math.max(0, highWatermark - watermark),
    complete: watermark === highWatermark && cursor?.version === 1
  }
}

/** Bounded, idempotent catalog invalidation; cursor and projected rows commit together. */
export function replayContextChanges(db: DatabaseSync, limit = 128): ContextDerivationStatus {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Invalid context replay limit')
  let status = contextDerivationStatus(db)
  if (
    status.watermark > status.highWatermark ||
    !db.prepare('SELECT 1 FROM context_derivation_cursor WHERE id=1 AND version=1').get()
  ) {
    db.exec(
      'DELETE FROM context_source_catalog; DELETE FROM context_derivation_cursor; INSERT INTO context_derivation_cursor VALUES(1,1,0);'
    )
    status = contextDerivationStatus(db)
  }
  const rows = db
    .prepare('SELECT * FROM context_changes WHERE sequence>? ORDER BY sequence LIMIT ?')
    .all(status.watermark, limit)
  const put =
    db.prepare(`INSERT INTO context_source_catalog VALUES(?,?,?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET
    timelineRevision=excluded.timelineRevision,controlsRevision=excluded.controlsRevision,sourceEpoch=excluded.sourceEpoch,sequence=excluded.sequence,deleted=excluded.deleted`)
  for (const row of rows) {
    put.run(
      row.threadId!,
      row.timelineRevision!,
      row.controlsRevision!,
      row.sourceEpoch!,
      row.sequence!,
      row.kind === 'delete' ? 1 : 0
    )
    db.prepare('UPDATE context_derivation_cursor SET sequence=? WHERE id=1').run(row.sequence!)
  }
  return contextDerivationStatus(db)
}
