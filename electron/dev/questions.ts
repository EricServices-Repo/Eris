import { createHash } from 'crypto'
import type { DevImportPreview, DevQuestion } from '../../src/shared/eris-dev'

const MAX_QUESTIONS = 10000
const NUMBERED = /^\s*(?:Q\s*)?\d{1,6}\s*[.):\]-]\s+(\S[\s\S]*)$/i
/** Looks like a heading: markdown, a trailing colon, or a corpus title line. */
const HEADER = /^#{1,6}\s|:\s*$|^(?:title|corpus|dataset|generated|source)\b[^?]*$/i

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/** Content-derived IDs: the same text keeps its ID across reordered or chunked imports. */
function identify(
  records: Array<{ text: string; sourceLine: number; intentReply?: DevQuestion['intentReply'] }>
): DevQuestion[] {
  const seen = new Map<string, number>()
  return records.map((record) => {
    const base = sha(record.text).slice(0, 12)
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return { id: `${base}-${occurrence}`, occurrence, ...record }
  })
}

function validText(value: unknown, position: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000)
    throw new Error(`Question ${position} must be nonempty text of at most 32,000 characters.`)
  return value.trim()
}

function intentReplyOf(record: unknown): DevQuestion['intentReply'] {
  const reply = (record as { intentReply?: unknown } | null)?.intentReply
  if (!reply || typeof reply !== 'object') return undefined
  const { intent, confidence } = reply as { intent?: unknown; confidence?: unknown }
  return typeof intent === 'string' && typeof confidence === 'number'
    ? { intent, confidence }
    : undefined
}

/**
 * Parse a question file and report exactly what was imported, normalized or
 * excluded. TXT: one question per line; numbered lists lose their numbers and
 * unnumbered headings are excluded with a reason. JSON: strings or
 * {question|text, intentReply?} records. JSONL: one such record per line.
 */
export function prepareQuestions(text: string, extension: string, name = ''): DevImportPreview {
  if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024)
    throw new Error('Question files must be 20 MB or smaller.')
  const source = text.replace(/^\uFEFF/, '')
  const excluded: DevImportPreview['excluded'] = []
  const normalization: string[] = []
  let records: Array<{ text: string; sourceLine: number; intentReply?: DevQuestion['intentReply'] }>

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
    records = raw.map(({ value, sourceLine }, index) => ({
      text: validText(
        typeof value === 'string'
          ? value
          : ((value as { question?: unknown; text?: unknown } | null)?.question ??
              (value as { text?: unknown } | null)?.text),
        index + 1
      ),
      sourceLine,
      intentReply: intentReplyOf(value)
    }))
  } else {
    const lines = source
      .split(/\r?\n/)
      .map((line, index) => ({ text: line.trim(), sourceLine: index + 1 }))
      .filter((line) => line.text)
    const numbered = lines.filter((line) => NUMBERED.test(line.text))
    if (numbered.length > 0 && numbered.length >= lines.length * 0.9) {
      records = []
      for (const line of lines) {
        const match = line.text.match(NUMBERED)
        if (match) records.push({ text: match[1]!.trim(), sourceLine: line.sourceLine })
        else excluded.push({ ...line, reason: 'unnumbered line in a numbered list' })
      }
      normalization.push('Removed leading question numbers.')
    } else {
      records = []
      let leading = true
      // In a file of questions, a few leading lines that are not questions are headings.
      const mostlyQuestions =
        lines.filter((line) => line.text.endsWith('?')).length >= lines.length * 0.9
      for (const line of lines) {
        // Headings are excluded only before the first question and only when they look like one.
        if (
          leading &&
          excluded.length < 10 &&
          !line.text.endsWith('?') &&
          (HEADER.test(line.text) || mostlyQuestions)
        ) {
          excluded.push({ ...line, reason: 'heading before the first question' })
          continue
        }
        if (/^#{1,6}\s/.test(line.text)) {
          excluded.push({ ...line, reason: 'markdown heading' })
          continue
        }
        leading = false
        records.push(line)
      }
    }
    if (excluded.length)
      normalization.push(`Excluded ${excluded.length} non-question line(s); see the list.`)
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
