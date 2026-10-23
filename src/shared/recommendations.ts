/**
 * Recommendations offered by an answer, as stable objects. Numbered lists,
 * bullets and advice paragraphs are all recognized, so a later “implement
 * those” does not depend on the formatting the reviewer happened to use.
 */
import { sourcePathsIn } from './agent-contract'
import type { RecommendationStatus, TaskRecommendation } from './task-contract'

const ADVICE =
  /\b(?:should|consider|add|use|avoid|replace|move|validate|handle|enforce|reject|remove|rename|extract|split|cache|document|test|guard|limit|check|ensure|prefer|upgrade|update|bump|refactor|introduce|implement|fix|migrate|switch|adopt|wrap|log|expose|return|retry|store|hash|encrypt|sanitize|escape|index|paginate|debounce|throttle|cap|bound|configure|enable|disable|require|restrict|lock|pin)\b/i
/** An item that opens with an advice verb: “Validate attempts…”, “Consider caching…”. */
const IMPERATIVE = new RegExp(
  `^(?:please\\s+)?(?:you\\s+should\\s+|we\\s+should\\s+)?${ADVICE.source}`,
  'i'
)

/** Sections whose items are what the answer recommends. */
const RECOMMENDATION_SECTION =
  /\b(?:recommend(?:ation|ed)?s?|suggest(?:ion|ed)?s?|improvements?|fixes|suggested fixes|next steps|action items|to-?dos?|proposals?|changes to make)\b/i
/**
 * Sections whose items describe the situation — dependencies, observed failures,
 * examples, logs, what was changed. Only an item that itself gives advice counts.
 */
const DESCRIPTIVE_SECTION =
  /\b(?:dependenc(?:y|ies)|requirements|prerequisites|observed|failures?|errors?|examples?|output|logs?|steps to reproduce|reproduction|files|changes made|what i changed|stack|environment|context|background|current behavio(?:u)?r)\b/i /** Small, dependency-free stable hash (FNV-1a, 64-bit as two 32-bit halves). */
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

interface ExtractedItem {
  text: string
  /** The heading the item appeared under, normalized; part of its identity. */
  section: string
}

function headingOf(line: string): string | null {
  const t = line.trim()
  const markdown = t.match(/^#{1,6}\s+(.+?)\s*#*$/)
  if (markdown) return markdown[1]!
  const bold = t.match(/^\*\*(.+?)\*\*:?$/)
  if (bold) return bold[1]!
  if (/^[^-*•\d].{0,80}:$/.test(t)) return t.slice(0, -1)
  return null
}

function itemsFrom(answer: string): ExtractedItem[] {
  const lines = answer.split(/\r?\n/)
  const listed: ExtractedItem[] = []
  let current: string | null = null
  let section = ''
  let fenced = false
  const flush = () => {
    const text = current?.trim()
    current = null
    if (!text) return
    // Under a recommendations heading every item counts; under a descriptive one only
    // advice does; with no heading an item must read as advice somewhere.
    const keep = RECOMMENDATION_SECTION.test(section)
      ? true
      : DESCRIPTIVE_SECTION.test(section)
        ? IMPERATIVE.test(text)
        : ADVICE.test(text)
    if (keep) listed.push({ text, section })
  }
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      flush()
      fenced = !fenced
      continue
    }
    // Code and quoted material are content, not the answer's own advice.
    if (fenced || /^\s*>/.test(line)) {
      flush()
      continue
    }
    const heading = headingOf(line)
    if (heading !== null) {
      flush()
      section = heading.toLowerCase().replace(/\s+/g, ' ').trim()
      continue
    }
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
  // Paragraph form: advice paragraphs, skipping headings, introductions and code.
  return answer
    .replace(/```[\s\S]*?(?:```|$)/g, '\n\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(
      (paragraph) =>
        paragraph &&
        !paragraph.endsWith(':') &&
        !paragraph.startsWith('>') &&
        ADVICE.test(paragraph)
    )
    .map((text) => ({ text, section: '' }))
}

/** Identity of a recommendation: its words, not its numbering, emphasis or punctuation. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/[.;:!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Maximum recommendations kept from one answer; far above any review's list. */
export const MAX_RECOMMENDATIONS = 200

/**
 * Recommendations offered by an answer. IDs come from each recommendation's own
 * normalized text, its section, and its occurrence — never from the whole answer —
 * so rewording the introduction keeps every ID, and a repeated recommendation in
 * another section stays distinct.
 */
export function extractRecommendations(answer: string): TaskRecommendation[] {
  const source = stableHash(answer)
  const occurrences = new Map<string, number>()
  return itemsFrom(answer)
    .filter((item) => item.text.length >= 8 && !item.text.endsWith(':'))
    .map((item) => {
      const identity = `${item.section}\n${normalized(item.text)}`
      const occurrence = (occurrences.get(identity) ?? 0) + 1
      occurrences.set(identity, occurrence)
      const targets = pathsIn(item.text)
      return {
        id: stableHash(`${identity}\n${occurrence}`),
        text: item.text,
        source,
        ...(item.section ? { section: item.section } : {}),
        ...(targets.length ? { targets } : {})
      }
    })
    .slice(0, MAX_RECOMMENDATIONS)
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
}

/** Numbers named in a phrase: “2 and 4”, “1-3”, “#5”, “the second”. */
function numbersIn(phrase: string, count: number): number[] {
  const out = new Set<number>()
  for (const match of phrase.matchAll(/(\d+)\s*(?:-|–|to|through)\s*(\d+)/gi))
    for (let n = Number(match[1]); n <= Number(match[2]); n++) out.add(n)
  for (const match of phrase
    .replace(/(\d+)\s*(?:-|–|to|through)\s*(\d+)/gi, ' ')
    .matchAll(/#?(\d+)/g))
    out.add(Number(match[1]))
  for (const [word, n] of Object.entries(ORDINALS))
    if (new RegExp(`\\b${word}\\b`, 'i').test(phrase)) out.add(n)
  if (/\blast\b/i.test(phrase)) out.add(count)
  return [...out].sort((a, b) => a - b)
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'one',
  'ones',
  'item',
  'items',
  'recommendation',
  'recommendations',
  'suggestion',
  'fix',
  'part',
  'about',
  'for',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on'
])

/** Items whose text shares the phrase's significant words. */
function itemsNamed(phrase: string, items: TaskRecommendation[]): TaskRecommendation[] {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
  if (!words.length) return []
  return items.filter((item) => {
    const text = item.text.toLowerCase()
    return words.every((word) => text.includes(word.replace(/s$/, '')))
  })
}

/** Which earlier recommendations a follow-up selected. */
export interface RecommendationSelection {
  mode: 'all' | 'numbered' | 'named' | 'except'
  selected: TaskRecommendation[]
  excluded: TaskRecommendation[]
  /** Set when part of the selection could not be resolved; the turn asks instead of guessing. */
  unresolved?: string
}

/**
 * FR-008: resolve “only items 2 and 4”, “all except caching”, “the first one” or
 * “the rate limiting one” against stable recommendation objects. A selection that
 * names something not offered is reported as unresolved rather than widened.
 */
export function selectRecommendations(
  text: string,
  offered: TaskRecommendation[]
): RecommendationSelection {
  const t = text.trim()
  const count = offered.length
  const byNumber = (numbers: number[]) =>
    numbers.map((n) => offered[n - 1]).filter(Boolean) as TaskRecommendation[]
  const outOfRange = (numbers: number[]) => numbers.filter((n) => n < 1 || n > count)
  const except = t.match(
    /\b(?:except(?:\s+for)?|but\s+not|other\s+than|excluding|apart\s+from|skip(?:ping)?|leave\s+out|(?:everything|all(?:\s+of\s+them)?|the\s+rest)\s+but)\s+(.+?)(?:[.!?]|$)/i
  )
  if (except) {
    const phrase = except[1]!
    const numbers = /\d|first|second|third|fourth|fifth|last/i.test(phrase)
      ? numbersIn(phrase, count)
      : []
    const excluded = numbers.length ? byNumber(numbers) : itemsNamed(phrase, offered)
    const bad = outOfRange(numbers)
    return {
      mode: 'except',
      selected: offered.filter((item) => !excluded.includes(item)),
      excluded,
      ...(bad.length
        ? { unresolved: `There is no recommendation ${bad.join(', ')}; ${count} were offered.` }
        : !excluded.length
          ? { unresolved: `No earlier recommendation matches “${phrase.trim()}”.` }
          : {})
    }
  }
  const numbered = t.match(
    /\b(?:(?:items?|recommendations?|suggestions?|numbers?|points?|fixes|steps?)\s*#?\s*((?:\d+\s*(?:,|and|&|-|–|to|through)?\s*)+)|#\s*(\d+)|(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(?:one|item|recommendation|suggestion|fix|two|three)?)/i
  )
  if (numbered) {
    let numbers = numbersIn(numbered[0], count)
    // “the first two/three”
    const firstN = t.match(/\bfirst\s+(two|three|four|five)\b/i)
    if (firstN)
      numbers = Array.from(
        { length: { two: 2, three: 3, four: 4, five: 5 }[firstN[1]!.toLowerCase() as 'two']! },
        (_, i) => i + 1
      )
    const bad = outOfRange(numbers)
    const selected = byNumber(numbers)
    return {
      mode: 'numbered',
      selected,
      excluded: offered.filter((item) => !selected.includes(item)),
      ...(bad.length
        ? { unresolved: `There is no recommendation ${bad.join(', ')}; ${count} were offered.` }
        : {})
    }
  }
  const named = t.match(
    /\b(?:only\s+)?the\s+((?:[\w-]+\s+){0,4}?[\w-]+)\s+(?:one|recommendation|suggestion|item|fix|change)\b/i
  )
  if (named && !/^(?:those|these|above|recommended|suggested|other)$/i.test(named[1]!.trim())) {
    const selected = itemsNamed(named[1]!, offered)
    return {
      mode: 'named',
      selected,
      excluded: offered.filter((item) => !selected.includes(item)),
      ...(selected.length
        ? {}
        : { unresolved: `No earlier recommendation matches “${named[1]!.trim()}”.` })
    }
  }
  return { mode: 'all', selected: offered, excluded: [] }
}

/**
 * FR-007: how the answer accounted for each selected recommendation, by number.
 * “2. Deferred — needs a schema migration” or “Recommendation 3: completed”. An
 * item the answer never mentions is pending, so nothing silently drops out.
 */
export function recommendationAccounting(
  answer: string,
  recommendations: TaskRecommendation[]
): RecommendationStatus[] {
  return recommendations.map((recommendation, index) => {
    const n = index + 1
    const line = answer
      .split(/\r?\n/)
      .find((text) =>
        new RegExp(
          `^\\s*(?:[-*•]\\s*)?(?:\\*\\*)?(?:recommendation|item|#)?\\s*${n}\\s*(?:[.):\\]]|\\*\\*|\\s-|\\s—)`,
          'i'
        ).test(text)
      )
    const state = line
      ?.match(
        /\b(completed?|done|implemented|applied|deferred|skipped|postponed|blocked|pending|not done)\b/i
      )?.[1]
      ?.toLowerCase()
    const mapped: RecommendationStatus['state'] = !state
      ? 'pending'
      : /^(?:complete|completed|done|implemented|applied)$/.test(state)
        ? 'completed'
        : /^(?:deferred|skipped|postponed)$/.test(state)
          ? 'deferred'
          : state === 'blocked'
            ? 'blocked'
            : 'pending'
    const reason = line?.match(/(?:—|–|-|:|because)\s*([^—–]+)$/)?.[1]?.trim()
    return {
      id: recommendation.id,
      state: mapped,
      ...((mapped === 'deferred' || mapped === 'blocked') && reason ? { reason } : {})
    }
  })
}
