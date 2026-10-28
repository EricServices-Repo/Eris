import { createHash } from 'crypto'
import { interpretationOf, type TaskContract } from '../../../src/shared/task-contract'
export interface OutcomeExcerpt {
  id: string
  source: string
  start: number
  end: number
  total: number
  digest: string
  text: string
}
/** Terms choose excerpts, never decide whether an obligation is satisfied. */
export function selectOutcomeEvidence(
  task: TaskContract,
  answer: string,
  items: string[],
  budget: number
) {
  const obligations = interpretationOf(task).obligations
  const sources = [
    { id: 'answer', text: answer },
    ...items.slice(0, 64).map((text, i) => ({ id: `e${i}`, text }))
  ]
  const excerpts: OutcomeExcerpt[] = [],
    coverage = obligations.map((o) => ({
      id: o.id,
      text: o.text,
      refs: [] as string[],
      omitted: false
    }))
  let remaining = Math.max(0, budget),
    truncated = items.length > 64
  const add = (source: (typeof sources)[number], start: number, size: number) => {
    const text = source.text.slice(start, start + Math.min(size, remaining)),
      end = start + text.length
    if (!text) return null
    const existing = excerpts.find(
      (e) => e.source === source.id && e.start === start && e.end === end
    )
    if (existing) return existing.id
    const id = `r${excerpts.length}`
    excerpts.push({
      id,
      source: source.id,
      start,
      end,
      total: source.text.length,
      digest: createHash('sha256').update(text).digest('hex'),
      text
    })
    remaining -= text.length
    return id
  }
  const total = sources.reduce((n, s) => n + s.text.length, 0)
  if (total <= remaining) {
    for (const source of sources) add(source, 0, source.text.length)
    for (const row of coverage) row.refs = excerpts.map((e) => e.id)
  } else {
    truncated = true
    const share = Math.min(1400, Math.floor(remaining / Math.max(1, coverage.length) / 2))
    for (const row of coverage) {
      const terms =
        row.text
          .toLowerCase()
          .match(/[a-z][a-z0-9_]{3,}/g)
          ?.filter(
            (w) =>
              !['with', 'that', 'this', 'must', 'should', 'code', 'file', 'from', 'only'].includes(
                w
              )
          )
          .slice(0, 12) ?? []
      for (const source of [sources[0], ...sources.slice(1).reverse()]) {
        if (row.refs.length >= 2 || remaining < 100 || share < 100) break
        let at = -1
        for (const term of terms) {
          const found = source.text.toLowerCase().lastIndexOf(term)
          if (found > at) at = found
        }
        // Tail fallback complements prefix-biased historical review; offsets remain auditable.
        const start = Math.max(
            0,
            (at < 0 ? source.text.length - share : at) - Math.floor(share / 4)
          ),
          ref = add(source, start, share)
        if (ref) row.refs.push(ref)
      }
      row.omitted = row.refs.length === 0
    }
  }
  return {
    version: 1,
    excerpts,
    obligations: coverage,
    truncated,
    totalSourceChars: total,
    selectedChars: excerpts.reduce((n, e) => n + e.text.length, 0),
    selection: 'bounded lexical sampling; not evidence of correctness'
  }
}
