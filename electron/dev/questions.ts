import { DevMemoryCaseSchema } from '../../src/shared/dev-memory-replay'
import { createHash } from 'crypto'
import type { DevImportPreview, DevQuestion } from '../../src/shared/eris-dev'

const MAX_QUESTIONS = 10000
const MAX_TEXT = 32000
const NUMBERED = /^\s*(?:Q\s*)?\d{1,6}\s*[.):\]-]\s+(\S[\s\S]*)$/i
/** Looks like a heading: markdown, a trailing colon, or a corpus title line. */
const HEADER = /^#{1,6}\s|:\s*$|^(?:title|corpus|dataset|generated|source)\b[^?]*$/i
/** A rule or separator line with no words: `=====`, `---`, `***`. */
const SEPARATOR = /^[\s=\-_*~#.]+$/
const INTENTS = new Set([
  'answer',
  'explore',
  'review',
  'plan',
  'verify',
  'edit',
  'run',
  'capability'
])

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/** Content-derived ID base: the case's text and the conversation it follows. */
export function contentBase(text: string, history?: DevQuestion['history']): string {
  // Prior turns are part of the case's identity: the same follow-up text after a
  // different conversation is a different question.
  return sha(history ? JSON.stringify([history, text]) : text).slice(0, 12)
}

/** The scripted resolver reply is a variant of the case, not part of its content. */
export function variantOf(intentReply: DevQuestion['intentReply'] | undefined): string | undefined {
  return intentReply ? `script-${sha(JSON.stringify(intentReply)).slice(0, 8)}` : undefined
}

type ImportRecord = {
  memory?: DevQuestion['memory']
  text: string
  sourceLine: number
  sourceId?: string
  intentReply?: DevQuestion['intentReply']
  intentReplyMalformed?: boolean
  history?: DevQuestion['history']
  historyChars?: number
}

/**
 * Content-derived IDs: the same text keeps its ID across reordered or chunked imports.
 * An explicit source ID in a JSON record is kept as the stable case ID instead.
 */
function identify(records: ImportRecord[]): DevQuestion[] {
  const seen = new Map<string, number>()
  const explicit = new Set<string>()
  return records.map((record) => {
    const base = contentBase(record.text, record.history)
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    if (record.sourceId) {
      if (explicit.has(record.sourceId))
        throw new Error(`Question ID “${record.sourceId}” appears more than once.`)
      explicit.add(record.sourceId)
    }
    const variant = variantOf(record.intentReply)
    return {
      id: record.sourceId ?? `${base}-${occurrence}`,
      occurrence,
      contentHash: base,
      text: record.text,
      sourceLine: record.sourceLine,
      ...(record.memory ? { memory: record.memory } : {}),
      ...(variant ? { variant } : {}),
      ...(record.intentReply ? { intentReply: record.intentReply } : {}),
      ...(record.intentReplyMalformed ? { intentReplyMalformed: true } : {}),
      ...(record.history ? { history: record.history } : {})
    }
  })
}

/**
 * FR-019: v1 exports carry no question IDs. Give each record the ID its text would
 * get on import today, counting duplicate occurrences in file order, so a v1 capture
 * aligns with a v2 run of the same corpus. Duplicated text is reported as ambiguous,
 * because a v1 file cannot say which occurrence is which once questions are reordered.
 */
export function migrateLegacyIdentity<
  T extends { questionId: string; question: string; identity?: string }
>(records: T[]): { records: T[]; migrated: number; ambiguous: string[] } {
  const seen = new Map<string, number>()
  const ambiguous = new Set<string>()
  let migrated = 0
  const out = records.map((record) => {
    if (record.identity !== 'v1-index') return record
    const base = contentBase(record.question.trim())
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    if (occurrence > 1) {
      ambiguous.add(`${base}-1`)
      ambiguous.add(`${base}-${occurrence}`)
    }
    migrated++
    return { ...record, questionId: `${base}-${occurrence}`, identity: 'v1-content' }
  })
  return { records: out, migrated, ambiguous: [...ambiguous] }
}

function validText(value: unknown, position: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT)
    throw new Error(`Question ${position} must be nonempty text of at most 32,000 characters.`)
  return value.trim()
}

function historyOf(record: unknown, position: number): DevQuestion['history'] {
  const history = (record as { history?: unknown } | null)?.history
  if (history === undefined) return undefined
  if (!Array.isArray(history) || history.length > 40)
    throw new Error(`Question ${position} history must be an array of at most 40 messages.`)
  return history.map((message, index) => {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown }
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string')
      throw new Error(
        `Question ${position} history message ${index + 1} needs a user or assistant role and text content.`
      )
    // A silently shortened turn would change the case without saying so.
    if (content.length > MAX_TEXT)
      throw new Error(
        `Question ${position} history message ${index + 1} has ${content.length.toLocaleString()} characters; the limit is 32,000. Shorten it in the source file.`
      )
    return { role, content }
  })
}

/**
 * A scripted resolver reply must match the production intent schema. A deliberately
 * malformed reply, for resolver-failure tests, is marked `"intentReplyMode": "malformed"`
 * on the record and passed through unchanged.
 */
function intentReplyOf(
  record: unknown,
  position: number
): { reply?: DevQuestion['intentReply']; malformed?: boolean } {
  const value = record as { intentReply?: unknown; intentReplyMode?: unknown } | null
  const reply = value?.intentReply
  if (reply === undefined) return {}
  if (value?.intentReplyMode === 'malformed')
    return { reply: reply as DevQuestion['intentReply'], malformed: true }
  const { intent, confidence } = (reply ?? {}) as { intent?: unknown; confidence?: unknown }
  if (typeof intent !== 'string' || !INTENTS.has(intent))
    throw new Error(
      `Question ${position} intentReply has unknown intent ${JSON.stringify(intent)}. Use one of ${[...INTENTS].join(', ')}, or mark the record "intentReplyMode": "malformed".`
    )
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))
    throw new Error(
      `Question ${position} intentReply confidence must be a number from 0 to 1, or mark the record "intentReplyMode": "malformed".`
    )
  return { reply: { intent, confidence } }
}

function sourceIdOf(record: unknown, position: number): string | undefined {
  const id = (record as { id?: unknown } | null)?.id
  if (id === undefined) return undefined
  if (typeof id !== 'string' || !/^[\w.:-]{1,128}$/.test(id))
    throw new Error(`Question ${position} id must be 1–128 letters, digits, or . _ : -`)
  return id
}

/**
 * Parse a question file and report exactly what was imported, normalized or
 * excluded. TXT: one question per line; numbered lists lose their numbers. Only
 * lines that look like headings or separators are excluded, each with its reason;
 * ordinary imperatives (“Fix the bug”) are chat requests and are kept. `include`
 * restores excluded source lines. JSON: strings or {id?, question|text, intentReply?,
 * history?} records. JSONL: one such record per line.
 */
export function prepareQuestions(
  text: string,
  extension: string,
  name = '',
  options: { include?: number[] } = {}
): DevImportPreview {
  const include = new Set(options.include ?? [])
  if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024)
    throw new Error('Question files must be 20 MB or smaller.')
  const source = text.replace(/^\uFEFF/, '')
  const excluded: DevImportPreview['excluded'] = []
  const normalization: string[] = []
  let records: ImportRecord[]

  if (extension === '.json' || extension === '.jsonl') {
    const raw: Array<{ value: unknown; sourceLine: number }> =
      extension === '.json'
        ? (() => {
            const parsed: unknown = JSON.parse(source)
            if (!Array.isArray(parsed)) throw new Error('A JSON question file must be an array.')
            return parsed.map((value, index) => ({ value, sourceLine: index + 1 }))
          })()
        : source
            .split(/\r?\n/)
            .flatMap((line, index) =>
              line.trim() ? [{ value: JSON.parse(line), sourceLine: index + 1 }] : []
            )
    records = raw.map(({ value, sourceLine }, index) => {
      const script = intentReplyOf(value, index + 1)
      return {
        text: validText(
          typeof value === 'string'
            ? value
            : ((value as { question?: unknown; text?: unknown } | null)?.question ??
                (value as { text?: unknown } | null)?.text),
          index + 1
        ),
        sourceLine,
        sourceId: sourceIdOf(value, index + 1),
        intentReply: script.reply,
        intentReplyMalformed: script.malformed,
        history: historyOf(value, index + 1),
        memory:
          typeof value === 'object' && value !== null && 'memory' in value
            ? DevMemoryCaseSchema.parse(value.memory)
            : undefined
      }
    })
    const scripted = records.filter((record) => record.intentReplyMalformed).length
    if (scripted)
      normalization.push(
        `${scripted} record(s) carry a deliberately malformed resolver reply for failure testing.`
      )
  } else {
    const lines = source
      .split(/\r?\n/)
      .map((line, index) => ({ text: line.trim(), sourceLine: index + 1 }))
      .filter((line) => line.text)
    const numbered = lines.filter((line) => NUMBERED.test(line.text))
    const exclude = (line: (typeof lines)[number], reason: string) => {
      if (include.has(line.sourceLine)) records.push(line)
      else excluded.push({ ...line, reason })
    }
    records = []
    // Numbered when most lines after the first number carry one; the preamble and
    // separators do not count against it.
    const body = numbered.length
      ? lines.filter(
          (line) => line.sourceLine >= numbered[0]!.sourceLine && !SEPARATOR.test(line.text)
        )
      : []
    if (numbered.length > 0 && numbered.length >= body.length * 0.5) {
      // Lines before the first number are the file's preamble; later unnumbered lines
      // are ordinary requests unless they are headings or separators.
      const first = numbered[0]!.sourceLine
      let kept = 0
      for (const line of lines) {
        const match = line.text.match(NUMBERED)
        if (match) records.push({ text: match[1]!.trim(), sourceLine: line.sourceLine })
        else if (line.sourceLine < first)
          exclude(line, 'preamble before the first numbered question')
        else if (SEPARATOR.test(line.text)) exclude(line, 'separator line')
        else if (/^#{1,6}\s/.test(line.text)) exclude(line, 'markdown heading')
        else {
          records.push(line)
          kept++
        }
      }
      normalization.push('Removed leading question numbers.')
      if (kept) normalization.push(`Kept ${kept} unnumbered line(s) as questions.`)
    } else {
      let leading = true
      for (const line of lines) {
        // Only lines that look like headings are excluded, and only before the first question.
        if (
          leading &&
          !line.text.endsWith('?') &&
          (HEADER.test(line.text) || SEPARATOR.test(line.text))
        ) {
          exclude(line, 'heading before the first question')
          continue
        }
        if (/^#{1,6}\s/.test(line.text)) {
          exclude(line, 'markdown heading')
          continue
        }
        leading = false
        records.push(line)
      }
    }
    records.sort((a, b) => a.sourceLine - b.sourceLine)
    if (excluded.length)
      normalization.push(`Excluded ${excluded.length} non-question line(s); see the list.`)
    if (include.size) normalization.push(`Restored ${include.size} excluded line(s) on request.`)
  }
  for (const [index, record] of records.entries()) validText(record.text, index + 1)
  if (!records.length) throw new Error('The file contains no questions.')
  if (records.length > MAX_QUESTIONS)
    throw new Error(
      `The file has ${records.length.toLocaleString()} questions after normalization` +
        (excluded.length ? ` (${excluded.length} line(s) excluded)` : '') +
        `; the limit is ${MAX_QUESTIONS.toLocaleString()}.`
    )
  return {
    name,
    corpusId: sha(source).slice(0, 16),
    questions: identify(records),
    excluded,
    normalization
  }
}

/** Question text only, for callers that do not need provenance. */
export function parseQuestions(text: string, extension: string): string[] {
  return prepareQuestions(text, extension).questions.map((question) => question.text)
}

/** Stable across schema parsing/reordered object keys, without serializing a whole corpus. */
export function memoryCorpusDigest(questions: readonly DevQuestion[]) {
  const hash = createHash('sha256')
  for (const q of questions)
    hash.update(
      JSON.stringify([
        q.id,
        q.text,
        q.history ?? [],
        q.intentReply ? [q.intentReply.intent, q.intentReply.confidence] : null,
        q.intentReplyMalformed ?? false,
        q.memory
          ? [
              q.memory.expectedSourceIds,
              q.memory.scriptedResponse ?? null,
              q.memory.rewindMessages ?? null,
              q.memory.forgottenSourceIds ?? null
            ]
          : null
      ])
    )
  return hash.digest('hex')
}
