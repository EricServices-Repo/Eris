import { isToolLogReply } from '../../../../src/shared/posted-answer'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import { proseOutsideTools } from './tool-parsing'

const STOP = new Set([
  'about',
  'after',
  'again',
  'being',
  'could',
  'every',
  'first',
  'from',
  'have',
  'into',
  'known',
  'often',
  'other',
  'their',
  'there',
  'these',
  'those',
  'under',
  'which',
  'while',
  'would',
  'years'
])

/** Search query for a public-web question, preferring the named person or topic. */
export function webSearchQuery(goal: string): string {
  const who = goal.match(/\bwho\s+(?:is|was|are)\s+(.+?)(?:\?|$)/i)
  const raw = who?.[1]
    ? who[1]
    : goal.replace(
        /\b(review|please|search|look\s+up|the\s+internet|on\s+the\s+(?:web|internet)|online)\b/gi,
        ' '
      )
  return raw.replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Public result URLs, in search-result order. Skips the search engine's own links. */
export function httpsResults(searchText: string, maxResults = 3): string[] {
  const matches = searchText.match(/https:\/\/[^\s)]+/g) ?? []
  const urls: string[] = []
  for (const raw of matches) {
    const url = raw.replace(/[.,]+$/, '')
    if (/duckduckgo\.com/i.test(url)) continue
    if (!urls.includes(url)) urls.push(url)
    if (urls.length >= maxResults) break
  }
  return urls
}

/** First public result URL. */
export function firstHttpsResult(searchText: string): string | null {
  return httpsResults(searchText, 1)[0] ?? null
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]{4,}/g) ?? []).filter((word) => !STOP.has(word))
}

/** Multi-word names and quoted titles that the sources never mention. */
export function unsupportedProperNames(answer: string, evidence: string, query: string): string[] {
  const hay = `${evidence}\n${query}`.toLowerCase()
  const found = new Set<string>()
  for (const match of answer.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)) {
    const name = match[0]
    if (!hay.includes(name.toLowerCase())) found.add(name)
  }
  for (const match of answer.matchAll(/"([^"]{2,80})"/g)) {
    const name = match[1]?.trim()
    if (name && !hay.includes(name.toLowerCase())) found.add(name)
  }
  return [...found]
}

/** True when the reply's content words actually occur in the sources. */
export function answerGroundedIn(answer: string, evidence: string, query: string): boolean {
  const queryWords = new Set(contentWords(query))
  const evidenceWords = new Set(contentWords(evidence))
  const answerWords = contentWords(answer).filter((word) => !queryWords.has(word))
  if (answerWords.length < 4) return false
  const overlap = answerWords.filter((word) => evidenceWords.has(word)).length
  return overlap >= 3 && overlap / answerWords.length >= 0.4
}

/** Short reply built only from the search hits and the opened page. */
export function extractiveWebAnswer(query: string, searchText: string, pageText: string): string {
  const q = query.trim() || 'that question'
  if (!searchText.trim()) return `I could not search the web for “${q}”.`
  if (!firstHttpsResult(searchText) && /No results\./.test(searchText) && !pageText.trim()) {
    return `I searched the web for “${q}” and did not find a public page.`
  }
  const parts = [`I searched the web for “${q}”.`]
  const hits = searchText.replace(/^Searched the web[^\n]*\n+/, '').trim()
  if (hits && hits !== 'No results.') parts.push('', hits.slice(0, AGENT_HANDOFF_CHARS))
  if (pageText.trim()) {
    const url = pageText.match(/^Opened (\S+)/)?.[1] ?? firstHttpsResult(pageText) ?? ''
    const title = pageText.match(/^Title: (.+)$/m)?.[1]?.trim()
    const body = pageText
      .replace(/^Opened [^\n]+\n/, '')
      .replace(/^Title: .+\n/, '')
      .trim()
    parts.push('', url ? `From ${url}${title ? ` (${title})` : ''}:` : 'From the opened page:')
    parts.push(body.slice(0, AGENT_HANDOFF_CHARS) || '(The page had no readable text.)')
  }
  return parts.join('\n')
}

/**
 * Keep a model reply only when it stays inside the sources.
 * Otherwise return the search hits and page text themselves.
 */
export function replyFromWebEvidence(
  modelText: string,
  query: string,
  searchText: string,
  pageText: string
): string {
  const q = query.trim() || 'that question'
  if (!searchText.trim()) return `I could not search the web for “${q}”.`
  const evidence = `${searchText}\n${pageText}`.trim()
  const prose = proseOutsideTools(modelText)
  const sourceUrls = [...new Set([...httpsResults(searchText), ...httpsResults(pageText)])]
  const citedSources = sourceUrls.filter((url) => prose.includes(url)).length
  const hasEnoughCitations = citedSources >= Math.min(2, sourceUrls.length)
  if (
    prose &&
    !isToolLogReply(prose) &&
    hasEnoughCitations &&
    unsupportedProperNames(prose, evidence, q).length === 0 &&
    answerGroundedIn(prose, evidence, q)
  ) {
    return prose
  }
  return extractiveWebAnswer(q, searchText, pageText)
}
