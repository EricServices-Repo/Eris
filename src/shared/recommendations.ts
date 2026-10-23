/**
 * Recommendations offered by an answer, as stable objects. Numbered lists,
 * bullets and advice paragraphs are all recognized, so a later “implement
 * those” does not depend on the formatting the reviewer happened to use.
 */
import { sourcePathsIn } from './agent-contract'
import type { TaskRecommendation } from './task-contract'

const ADVICE =
  /\b(?:should|consider|add|use|avoid|replace|move|validate|handle|enforce|reject|remove|rename|extract|split|cache|document|test|guard|limit|check|ensure|prefer)\b/i

/** Small, dependency-free stable hash (FNV-1a, 64-bit as two 32-bit halves). */
export function stableHash(value: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x811c9dc5) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** Workspace paths named in the text; technology names such as Next.js are not files. */
export function pathsIn(text: string): string[] {
  return sourcePathsIn(text)
}

function itemsFrom(answer: string): string[] {
  const lines = answer.split(/\r?\n/)
  const listed: string[] = []
  let current: string | null = null
  const flush = () => {
    if (current?.trim()) listed.push(current.trim())
    current = null
  }
  for (const line of lines) {
    const item = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*)$/)
    if (item) {
      flush()
      current = item[1]!
    } else if (current !== null && line.trim() && /^\s{2,}/.test(line)) {
      current += ` ${line.trim()}`
    } else flush()
  }
  flush()
  if (listed.length) return listed
  // Paragraph form: advice paragraphs, skipping headings and introductions.
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph && !paragraph.endsWith(':') && ADVICE.test(paragraph))
}

export function extractRecommendations(answer: string): TaskRecommendation[] {
  const source = stableHash(answer)
  const seen = new Set<string>()
  return itemsFrom(answer)
    .filter((text) => text.length >= 8 && !text.endsWith(':'))
    .flatMap((text) => {
      const id = stableHash(`${source}\n${text}`)
      if (seen.has(id)) return []
      seen.add(id)
      const targets = pathsIn(text)
      return [{ id, text, source, ...(targets.length ? { targets } : {}) }]
    })
    .slice(0, 30)
}
