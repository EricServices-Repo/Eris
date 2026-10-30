import { createHash } from 'crypto'
import type { ChatMessage } from '../../../src/shared/settings-schema'
export type Decision = {
  sourceId: string
  scope: string | null
  subject: string
  value: string
  offset: number
  length: number
  correction: boolean
  state: 'active' | 'superseded' | 'disputed'
}
/** Restricted declarations only. Quotation, uncertain prose and negation remain raw evidence. */
export function declaredDecisions(message: ChatMessage): Decision[] {
  if (message.role !== 'user') return []
  const found: Decision[] = []
  let fenced = false,
    offset = message.contextContentOffset ?? 0
  for (const line of message.content.slice(0, 32768).split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    if (!fenced && !/["'`“”]|\b(?:not|never|maybe|perhaps|possibly|might)\b|\?/.test(line)) {
      const match =
        /^\s*(Remember|Decision|Correction|Actually)[,:]\s*(.{1,100}?)\s*(?:=|:|\bis\b|\bmust (?:be|use)\b|\bshould (?:be|use)\b)\s*(.{1,200})\s*$/i.exec(
          line
        ) ??
        /^\s*(Remember|Decision|Correction|Actually)[,:]\s*(.{1,80}?currency)\s+([A-Z]{3})\s*[.!]?$/i.exec(
          line
        )
      if (match) {
        const value = match[3]
          .replace(/\s+(?:instead of|rather than|\(replaces)\s+.*$/i, '')
          .replace(/[.!]+$/, '')
          .trim()
        if (value)
          found.push({
            sourceId: message.id,
            scope: message.contextProjectRoot ?? null,
            subject: match[2].trim().toLocaleLowerCase().replace(/\s+/g, ' '),
            value,
            offset,
            length: line.length,
            correction: /correction|actually/i.test(match[1]),
            state: 'active'
          })
      }
    }
    offset += line.length + 1
    if (found.length >= 4) break
  }
  return found
}
const keyOf = (d: Decision) => JSON.stringify([d.scope, d.subject])
export const decisionId = (d: Decision) =>
  createHash('sha256')
    .update(JSON.stringify([d.sourceId, d.offset, d.scope, d.subject, d.value, d.state]))
    .digest('hex')
/** At most 512 subjects, four provenance records each; no arbitrary semantic inference. */
export class DecisionIndex {
  private groups = new Map<string, Decision[]>()
  bytes = 0
  private cost = (rows: Decision[]) => Buffer.byteLength(JSON.stringify(rows)) * 4 + 256
  add(message: ChatMessage) {
    for (const next of declaredDecisions(message)) {
      const key = keyOf(next),
        prior = this.groups.get(key) ?? []
      if (prior.some((d) => d.sourceId === next.sourceId && d.offset === next.offset)) continue
      if (!this.groups.has(key) && this.groups.size >= 512) {
        const oldest = this.groups.keys().next().value!
        this.bytes -= this.cost(this.groups.get(oldest)!)
        this.groups.delete(oldest)
      }
      if (prior.length) this.bytes -= this.cost(prior)
      const current = prior.filter((d) => d.state !== 'superseded')
      if (next.correction) for (const old of prior) old.state = 'superseded'
      else if (current.some((d) => d.value !== next.value)) {
        next.state = 'disputed'
        for (const old of current) old.state = 'disputed'
      }
      const rows = [...prior, next].slice(-4)
      this.groups.set(key, rows)
      this.bytes += this.cost(rows)
    }
  }
  forMessage(message: ChatMessage) {
    return declaredDecisions(message).map(
      (d) =>
        this.groups
          .get(keyOf(d))
          ?.find((known) => known.sourceId === d.sourceId && known.offset === d.offset) ?? {
          ...d,
          state: 'superseded' as const
        }
    )
  }
  currentId(id: string) {
    return [...this.groups.values()].some((rows) =>
      rows.some((d) => d.state !== 'superseded' && decisionId(d) === id)
    )
  }
}
