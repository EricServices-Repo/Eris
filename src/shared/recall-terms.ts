/** Bump when tokenizing or scoring changes, so stored evaluations compare like with like. */
export const RECALL_RANKING_VERSION = 2
const TOKEN = /[\p{L}\p{N}_$]+(?:[./\\:-][\p{L}\p{N}_$]+)*[#+]*/gu
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu
const MAX_TERM_CHARS = 96
const MAX_RECORD_TERMS = 2048
const STOPWORDS = new Set(
  `a am an and are as at be but by can do for from he her his how i if in into is it its me
  my no not of on or our she so that the their them then there these they this those to up us
  was we were what when where which who why will with you your please make change`.split(/\s+/)
)
/** Shapes the same word or identifier takes across prose, casing and diacritics. */
function fold(value: string) {
  return value
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFKC')
    .toLowerCase()
}
const singular = (word: string) =>
  !/^[a-z]+$/.test(word) || word.length < 4
    ? word
    : word.endsWith('ies')
      ? `${word.slice(0, -3)}y`
      : word.endsWith('s') && !word.endsWith('ss')
        ? word.slice(0, -1)
        : word
/** Two characters are ambiguous in prose. Only a capitalized form stays, as a name like Go. */
function shortName(raw: string) {
  const word = fold(raw)
  if (STOPWORDS.has(word) || raw === word) return null
  return word[0]!.toUpperCase() + word.slice(1)
}
function wordTerm(raw: string) {
  if (/[#+]$/.test(raw)) return fold(raw)
  const word = fold(raw)
  if ([...word].length < 3) return shortName(raw)
  return STOPWORDS.has(word) ? null : singular(word)
}
const identifierWords = (segment: string) =>
  segment
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean)
function cjkGrams(segment: string) {
  const grams: string[] = []
  for (const [run] of segment.matchAll(CJK_RUN)) {
    const chars = [...run]
    if (chars.length === 1) grams.push(run)
    for (let i = 0; i + 1 < chars.length; i++) grams.push(chars[i]! + chars[i + 1]!)
  }
  return grams
}
/** One query unit: `whole` alone matches, or every part of a split identifier together. */
export type RecallToken = { whole: string | null; parts: string[]; exact: boolean }
function segmentTokens(segment: string): RecallToken[] {
  const out: RecallToken[] = []
  const grams = cjkGrams(segment)
  const text = grams.length ? segment.replace(CJK_RUN, ' ') : segment
  for (const gram of grams) out.push({ whole: gram, parts: [], exact: false })
  for (const piece of text.split(/\s+/).filter(Boolean)) {
    const words = identifierWords(piece)
    if (words.length < 2) {
      const whole = piece.length <= MAX_TERM_CHARS ? wordTerm(piece) : null
      if (whole) out.push({ whole, parts: [], exact: false })
      continue
    }
    const parts = words.flatMap((word) => wordTerm(word) ?? [])
    const whole = piece.length <= MAX_TERM_CHARS ? fold(words.join('')) : null
    if (whole || parts.length) out.push({ whole, parts, exact: true })
  }
  return out
}
const exactTerm = (value: string): RecallToken => ({
  whole: fold(value).replace(/\\/g, '/'),
  parts: [],
  exact: true
})
/**
 * Stored text yields every term a later query could name. A query path or file name
 * is stricter: `src/a/login.ts` must not match another file by sharing `src` and `ts`.
 */
function analyze(raw: string, purpose: 'record' | 'query'): RecallToken[] {
  if (!/[./\\:-]/.test(raw)) return segmentTokens(raw)
  const whole = raw.length <= MAX_TERM_CHARS ? [exactTerm(raw)] : []
  const words = raw.split(/[./\\:-]+/).flatMap(segmentTokens)
  if (purpose === 'query' && !/[./\\:]/.test(raw))
    return [
      {
        whole: whole[0]?.whole ?? null,
        parts: words.flatMap((word) => word.whole ?? word.parts),
        exact: true
      }
    ]
  const files = raw
    .split(/[/\\:]+/)
    .filter((segment) => segment.includes('.') && segment.length <= MAX_TERM_CHARS)
    .map(exactTerm)
  return purpose === 'query' ? [...whole, ...files] : [...whole, ...files, ...words]
}
/** Tokenizing a page must stay cheap: identical words recur heavily across messages. */
const MAX_CACHED_WORDS = 50000
const recordTermCache = new Map<string, readonly string[]>()
function recordTerms(raw: string): readonly string[] {
  if (/^[a-z]{3,}$/.test(raw)) {
    const word = STOPWORDS.has(raw) ? null : singular(raw)
    return word ? [word] : []
  }
  const cached = recordTermCache.get(raw)
  if (cached) return cached
  const terms = analyze(raw, 'record').flatMap((token) =>
    [token.whole ?? [], ...token.parts].flat()
  )
  if (recordTermCache.size >= MAX_CACHED_WORDS) recordTermCache.clear()
  recordTermCache.set(raw, terms)
  return terms
}
const unique = (tokens: RecallToken[]) =>
  new Map(tokens.map((token) => [`${token.whole}\0${token.parts.join('\0')}`, token]))
/** Bounded, deduplicated terms for one stored record. Runs in the workspace worker. */
export function recallTerms(text: string): string[] {
  const terms = new Set<string>()
  const seen = new Set<string>()
  for (const [raw] of text.matchAll(TOKEN)) {
    if (seen.has(raw)) continue
    seen.add(raw)
    for (const term of recordTerms(raw)) terms.add(term)
    if (terms.size >= MAX_RECORD_TERMS) break
  }
  return [...terms].slice(0, MAX_RECORD_TERMS)
}
export function recallQuery(text: string, limit = 24): RecallToken[] {
  const tokens: RecallToken[] = []
  for (const [raw] of text.matchAll(TOKEN)) tokens.push(...analyze(raw, 'query'))
  return [...unique(tokens).values()].slice(0, limit)
}
/** Scoring points for one query token, or 0 when the record does not satisfy it. */
export function tokenScore(token: RecallToken, has: (term: string) => boolean) {
  if (token.whole && has(token.whole)) return token.exact ? 16 : 8
  return token.parts.length > 1 && token.parts.every(has) ? 8 : 0
}
export function queryTerms(tokens: readonly RecallToken[]) {
  return [...new Set(tokens.flatMap((token) => [token.whole ?? [], ...token.parts].flat()))]
}
/** Offset of the first source token carrying a matched term, to anchor an exact excerpt. */
export function firstMatchOffset(content: string, matched: ReadonlySet<string>) {
  for (const found of content.matchAll(TOKEN))
    for (const token of analyze(found[0], 'record'))
      if (
        (token.whole && matched.has(token.whole)) ||
        token.parts.some((part) => matched.has(part))
      )
        return found.index
  return -1
}

/** Host-provided, scoped hints. Never pass raw renderer history as recent text. */
export type RecallQueryHints = {
  files?: readonly string[]
  task?: string
  recent?: readonly string[]
}
export const isRecallFollowup = (text: string) =>
  /\b(?:that|those|same|other|again|before|continue|resume|remaining|previous|earlier)\b/i.test(
    text
  )
/** At most six expansion units; explicit queries retain their existing ranking. */
export function recallExpansion(text: string, hints: RecallQueryHints = {}): string {
  if (!isRecallFollowup(text)) return ''
  const primary = new Set(queryTerms(recallQuery(text.slice(0, 8192))))
  const candidates = [
    ...(hints.files ?? []).slice(0, 4),
    hints.task ?? '',
    ...(hints.recent ?? []).slice(0, 1)
  ]
  const expansion = recallQuery(candidates.map((part) => part.slice(0, 600)).join(' '), 12)
    .filter((token) => token.whole && !primary.has(token.whole))
    .slice(0, 6)
  return expansion.map((token) => token.whole).join(' ')
}
/** One primary match outweighs the entire six-unit expansion (max 12 points). */
export function weightedRecallQuery(text: string, expansion = '') {
  return [
    ...recallQuery(text.slice(0, 8192)).map((token) => ({ token, weight: expansion ? 4 : 1 })),
    ...recallQuery(expansion.slice(0, 1024), 6).map((token) => ({ token, weight: 0.125 }))
  ]
}
