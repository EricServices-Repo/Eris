import type { DatabaseSync } from 'node:sqlite'
import type {
  DurableJournalEntry,
  DurableJournalHit,
  DurableJournalMeta,
  DurableJournalRead
} from '../../../src/shared/context-journal'
import type { MemoryControls } from '../../../src/shared/context-memory'
import { queryTerms, recallQuery, recallTerms } from '../../../src/shared/recall-terms'

/** Metadata stays after eviction, so it needs its own cap. */
const MAX_ENTRIES_PER_THREAD = 5_000
const MAX_TERMS_PER_ENTRY = 4_096
const MAX_QUERY_TERMS = 16
const POSTINGS_PER_TERM = 256
const SNIPPET_CHARS = 240
const MAX_SEARCH_ROWS = 64

/** Worker-only. Conversation rows stay canonical: every read rechecks the source they cite. */
export function installJournalStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_journal (
      threadId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ref TEXT NOT NULL, sourceId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL,
      toolName TEXT NOT NULL, argsSummary TEXT NOT NULL, trust TEXT NOT NULL,
      bytes INTEGER NOT NULL, storedBytes INTEGER NOT NULL, at INTEGER NOT NULL,
      projectRoot TEXT, text TEXT, omitted TEXT,
      PRIMARY KEY(threadId,ref));
    CREATE INDEX IF NOT EXISTS context_journal_age ON context_journal(threadId,at,seq);
    CREATE INDEX IF NOT EXISTS context_journal_source ON context_journal(threadId,sourceId);
    CREATE TABLE IF NOT EXISTS context_journal_terms (
      threadId TEXT NOT NULL, term TEXT NOT NULL, ref TEXT NOT NULL,
      PRIMARY KEY(threadId,term,ref),
      FOREIGN KEY(threadId,ref) REFERENCES context_journal(threadId,ref) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS context_journal_terms_ref ON context_journal_terms(threadId,ref);`)
}

const meta = (row: Record<string, unknown>): DurableJournalMeta => ({
  ref: String(row.ref),
  sourceId: String(row.sourceId),
  runId: String(row.runId),
  seq: Number(row.seq),
  toolName: String(row.toolName),
  argsSummary: String(row.argsSummary),
  trust: row.trust as DurableJournalMeta['trust'],
  bytes: Number(row.bytes),
  at: Number(row.at),
  projectRoot: row.projectRoot === null ? null : String(row.projectRoot),
  omitted: row.omitted === null ? null : String(row.omitted)
})

/** Metadata stays indexed, so a search can say output existed and was not kept. */
function indexEntry(db: DatabaseSync, id: string, ref: string, text: string) {
  db.prepare('DELETE FROM context_journal_terms WHERE threadId=? AND ref=?').run(id, ref)
  const put = db.prepare('INSERT OR IGNORE INTO context_journal_terms VALUES(?,?,?)')
  for (const term of recallTerms(text).slice(0, MAX_TERMS_PER_ENTRY)) put.run(id, term, ref)
}

/** Oldest text goes first and its row stays, so a later reader learns it was evicted. */
function enforceBudget(db: DatabaseSync, id: string, maxBytes: number) {
  const used = () =>
    Number(
      db
        .prepare('SELECT COALESCE(SUM(storedBytes),0) AS n FROM context_journal WHERE threadId=?')
        .get(id)!.n
    )
  let over = used() - maxBytes
  while (over > 0) {
    const oldest = db
      .prepare(
        'SELECT ref,toolName,argsSummary,storedBytes FROM context_journal WHERE threadId=? AND text IS NOT NULL ORDER BY at,seq LIMIT 1'
      )
      .get(id)
    if (!oldest) break
    db.prepare(
      "UPDATE context_journal SET text=NULL,storedBytes=0,omitted='over-thread-budget' WHERE threadId=? AND ref=?"
    ).run(id, oldest.ref!)
    indexEntry(db, id, String(oldest.ref), `${oldest.toolName} ${oldest.argsSummary}`)
    over -= Number(oldest.storedBytes)
  }
  db.prepare(
    `DELETE FROM context_journal WHERE threadId=? AND ref IN (
      SELECT ref FROM context_journal WHERE threadId=? ORDER BY at DESC,seq DESC LIMIT -1 OFFSET ?)`
  ).run(id, id, MAX_ENTRIES_PER_THREAD)
}

/** False when the run's source message is gone, so nothing outlives what it belongs to. */
export function writeJournalEntry(
  db: DatabaseSync,
  id: string,
  entry: DurableJournalEntry,
  maxBytes: number
) {
  const text = entry.text
  const storedBytes = text === null ? 0 : Buffer.byteLength(text, 'utf8')
  const fits = storedBytes <= maxBytes
  const inserted = db
    .prepare(
      `INSERT OR REPLACE INTO context_journal(threadId,ref,sourceId,runId,seq,toolName,argsSummary,trust,bytes,storedBytes,at,projectRoot,text,omitted)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE threadId=? AND id=?)`
    )
    .run(
      id,
      entry.ref,
      entry.sourceId,
      entry.runId,
      entry.seq,
      entry.toolName,
      entry.argsSummary,
      entry.trust,
      entry.bytes,
      fits ? storedBytes : 0,
      entry.at,
      entry.projectRoot,
      fits ? text : null,
      fits ? (entry.omitted ?? null) : 'over-thread-budget',
      id,
      entry.sourceId
    )
  if (!inserted.changes) return false
  const metadata = `${entry.toolName} ${entry.argsSummary}`
  indexEntry(
    db,
    id,
    entry.ref,
    fits && text
      ? `${metadata}
${text}`
      : metadata
  )
  enforceBudget(db, id, maxBytes)
  return true
}

type SourceRow = { ordinal: number; sequence: number; role: string }

function sourceRow(db: DatabaseSync, id: string, sourceId: string): SourceRow | null {
  const row = db
    .prepare(
      "SELECT ordinal,contextSequence,json_extract(body,'$.role') AS role FROM messages WHERE threadId=? AND id=? ORDER BY ordinal LIMIT 1"
    )
    .get(id, sourceId)
  return row
    ? {
        ordinal: Number(row.ordinal),
        sequence: Number(row.contextSequence),
        role: String(row.role)
      }
    : null
}

/** The same forget and cutoff rules as message recall, applied to the run's source message. */
function excluded(source: SourceRow | null, sourceId: string, controls: MemoryControls) {
  if (!source || controls.forgotten.includes(sourceId)) return true
  return controls.afterSequence !== undefined
    ? source.sequence <= controls.afterSequence
    : source.ordinal < controls.afterOrdinal
}

/** Removes rows for a rewound, rewritten or forgotten source, with their index rows. */
export function purgeJournal(db: DatabaseSync, id: string, controls: MemoryControls) {
  const sources = db
    .prepare('SELECT DISTINCT sourceId FROM context_journal WHERE threadId=?')
    .all(id)
  const drop = db.prepare('DELETE FROM context_journal WHERE threadId=? AND sourceId=?')
  for (const { sourceId } of sources) {
    const key = String(sourceId)
    if (excluded(sourceRow(db, id, key), key, controls)) drop.run(id, key)
  }
}

function snippetFor(text: string | null, terms: readonly string[]) {
  if (!text) return ''
  const lower = text.toLowerCase()
  const first = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0)
  const start = Math.max(0, (first.length ? Math.min(...first) : 0) - SNIPPET_CHARS / 3)
  return text
    .slice(start, start + SNIPPET_CHARS)
    .replace(/\s+/g, ' ')
    .trim()
}

function usable(
  row: DurableJournalMeta,
  source: SourceRow | null,
  controls: MemoryControls,
  projectRoot: string | null | undefined
) {
  if (excluded(source, row.sourceId, controls)) return false
  return projectRoot === undefined || row.projectRoot === projectRoot
}

export function searchJournal(
  db: DatabaseSync,
  id: string,
  query: string,
  limit: number,
  controls: MemoryControls,
  projectRoot?: string | null
): DurableJournalHit[] {
  const terms = queryTerms(recallQuery(query.slice(0, 8192))).slice(0, MAX_QUERY_TERMS)
  if (!terms.length) return []
  const slices = terms
    .map(
      () => `SELECT ref FROM (SELECT ref FROM context_journal_terms
        WHERE threadId=? AND term=? ORDER BY ref LIMIT ${POSTINGS_PER_TERM})`
    )
    .join(' UNION ALL ')
  const rows = db
    .prepare(
      `SELECT j.*,hits.score FROM context_journal j JOIN (
        SELECT ref,COUNT(*) AS score FROM (${slices}) GROUP BY ref
      ) hits ON hits.ref=j.ref WHERE j.threadId=? ORDER BY hits.score DESC,j.at DESC LIMIT ${MAX_SEARCH_ROWS}`
    )
    .all(...terms.flatMap((term) => [id, term]), id)
  const hits: DurableJournalHit[] = []
  for (const row of rows) {
    const entry = meta(row)
    if (!usable(entry, sourceRow(db, id, entry.sourceId), controls, projectRoot)) continue
    hits.push({
      entry,
      score: Number(row.score),
      snippet: snippetFor(row.text === null ? null : String(row.text), terms)
    })
    if (hits.length >= limit) break
  }
  return hits
}

export function readJournal(
  db: DatabaseSync,
  id: string,
  ref: string,
  controls: MemoryControls,
  projectRoot?: string | null
): DurableJournalRead {
  const row = db.prepare('SELECT * FROM context_journal WHERE threadId=? AND ref=?').get(id, ref)
  if (!row) return { status: 'unavailable' }
  const entry = meta(row)
  if (!usable(entry, sourceRow(db, id, entry.sourceId), controls, projectRoot))
    return { status: 'unavailable' }
  return row.text === null
    ? { status: 'omitted', entry }
    : { status: 'found', entry, text: String(row.text) }
}
