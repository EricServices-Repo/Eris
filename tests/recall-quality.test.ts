import { describe, expect, it } from 'vitest'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { ChatDatabase } from '../electron/main/services/chat-database'
import { RecallIndex } from '../electron/main/services/context-recall-index'
import {
  firstMatchOffset,
  recallQuery,
  recallExpansion,
  weightedRecallQuery,
  tokenScore,
  recallTerms,
  RECALL_RANKING_VERSION
} from '../src/shared/recall-terms'
import { emptyMemoryControls } from '../src/shared/context-memory'
import { LABELED } from '../checks/context-recall-labels'
import type { ChatMessage } from '../src/shared/settings-schema'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const message = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
function storeWith(messages: ChatMessage[], forgotten: string[] = []) {
  const store = new ContextMemoryStore()
  store.install(
    'thread',
    {
      revision: 1,
      total: messages.length,
      records: messages.map((m, ordinal) => ({ ordinal, message: m })),
      controls: { ...emptyMemoryControls(), forgotten },
      partial: false
    },
    store.token('thread')
  )
  return store
}
const filler = (count: number) =>
  Array.from({ length: count }, (_, i) => message(`noise-${i}`, `Routine status update ${i}`))
const sources = (result: Awaited<ReturnType<ContextMemoryStore['select']>>) =>
  result.inspection.facts.map((fact) => fact.sourceId)

describe('labeled recall', () => {
  it.each(LABELED)('$name', async ({ query, expected, distractor }) => {
    const store = storeWith([
      message('expected', expected),
      message('distractor', distractor),
      ...filler(40)
    ])
    const found = sources(await store.select('thread', query))
    expect(found).toContain('expected')
    expect(found).not.toContain('distractor')
  })
  it('quotes the original text, not its normalized form', async () => {
    const original = 'Ｆｕｌｌｗｉｄｔｈ note: Café BookingConfirmation stays exact'
    const store = storeWith([message('a', original), ...filler(20)])
    const [fact] = (await store.select('thread', 'cafe')).inspection.facts
    expect(fact?.text).toBe(original)
  })
  it('anchors a long message at the matched token', async () => {
    const padding = 'x '.repeat(4000)
    const store = storeWith([message('a', `${padding}the rareterm decision`), ...filler(20)])
    const [fact] = (await store.select('thread', 'rareterm')).inspection.facts
    expect(fact?.text).toContain('rareterm decision')
  })
  it('selects one excerpt per source and records the ranking version', async () => {
    const store = storeWith([
      { ...message('same', 'checkout one'), contextContentOffset: 0, contextContentLength: 12 },
      { ...message('same', 'checkout two'), contextContentOffset: 12, contextContentLength: 12 }
    ])
    const result = await store.select('thread', 'checkout')
    expect(sources(result)).toEqual(['same'])
    expect(result.prompt.manifest.rankingVersion).toBe(RECALL_RANKING_VERSION)
  })
})

describe('bounded retrieval', () => {
  it('materializes the same candidates however long the archive is', async () => {
    const counts: number[] = []
    for (const size of [500, 5000]) {
      const store = storeWith(
        Array.from({ length: size }, (_, i) => message(String(i), `checkout decision ${i}`))
      )
      const result = await store.select('thread', 'checkout')
      counts.push(result.inspection.facts.length)
      expect(result.prompt.manifest.omittedFacts).toBeGreaterThan(0)
    }
    expect(counts[0]).toBe(counts[1])
  })
  it('prefers the newest rows of a very common term', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => message(String(i), `checkout note ${i}`))
    const found = sources(await storeWith(rows).select('thread', 'checkout'))
    expect(found).toContain('2999')
    expect(found).not.toContain('0')
  })
  it('caps the terms a single record can contribute', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ')
    expect(recallTerms(body).length).toBeLessThanOrEqual(2048)
  })
  it('skips a large exclusion set without testing each row against it', async () => {
    const forgotten = Array.from({ length: 10000 }, (_, i) => `gone-${i}`)
    const rows = [message('gone-5', 'checkout excluded'), message('kept', 'checkout kept')]
    const found = sources(await storeWith(rows, forgotten).select('thread', 'checkout'))
    expect(found).toEqual(['kept'])
  })
  it('keeps a query bounded', () => {
    const query = Array.from({ length: 100 }, (_, i) => `distinct${i}`).join(' ')
    expect(recallQuery(query)).toHaveLength(24)
  })
  it('stops matching rows trimmed out of retention', async () => {
    const store = storeWith([message('old', 'zebra note'), message('new', 'zebra later')])
    store.configureNamespace('thread', {
      ...store.config,
      maxMessages: 500,
      maxThreadMiB: 4
    })
    expect(sources(await store.select('thread', 'zebra'))).toContain('new')
    const index = new RecallIndex()
    index.add(0, ['zebra'])
    index.add(1, ['zebra'])
    index.prune(1, ['zebra'])
    expect([...index.match(['zebra']).keys()]).toEqual([1])
    index.prune(2, ['zebra'])
    expect(index.match(['zebra']).size).toBe(0)
  })
  it('indexes appended rows without rebuilding history', async () => {
    const store = storeWith([message('a', 'first row')])
    store.append('thread', 2, 2, [message('b', 'quokka decision')], 1)
    expect(sources(await store.select('thread', 'quokka'))[0]).toBe('b')
    store.append('thread', 3, 3, [message('c', 'second quokka decision')], 2)
    expect(sources(await store.select('thread', 'quokka'))).toEqual(
      expect.arrayContaining(['b', 'c'])
    )
  })
})

describe('recall terms', () => {
  it('prepares terms in the worker page', () => {
    const folder = mkdtempSync(join(tmpdir(), 'eris-recall-'))
    const db = new ChatDatabase(folder)
    db.save({
      id: 't',
      title: 'History',
      model: 'local:test',
      createdAt: 1,
      updatedAt: 1,
      messages: [message('a', 'bookingConfirmation decision')]
    })
    expect(db.contextPage('t')?.records[0]?.terms).toEqual(
      expect.arrayContaining(['bookingconfirmation', 'booking', 'confirmation', 'decision'])
    )
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })
  it('finds a token offset in the raw string', () => {
    expect(firstMatchOffset('Ａ then bookingConfirmation', new Set(['booking']))).toBe(7)
    expect(firstMatchOffset('nothing here', new Set(['booking']))).toBe(-1)
  })
})

describe('contextual follow-up query (#235)', () => {
  it('finds a buried topic from eligible recent context without using excluded rows', async () => {
    const store = storeWith(
      [
        message('old', 'bookingConfirmation returns the receipt code'),
        ...filler(40),
        message('recent', 'bookingConfirmation needs the same validation'),
        message('forgotten', 'privateSecretFeature must be rewritten')
      ],
      ['forgotten']
    )
    const query = 'do the same for the other module'
    expect(sources(await store.select('thread', query))).not.toContain('old')
    const expansion = store.queryExpansion('thread', query, {})
    expect(expansion).toContain('bookingconfirmation')
    expect(expansion).not.toContain('privatesecretfeature')
    expect(sources(await store.select('thread', query, { queryExpansion: expansion }))).toContain(
      'old'
    )
  })
  it('keeps explicit queries unchanged and primary matches stronger than all expansion', () => {
    expect(recallExpansion('checkout currency', { recent: ['unrelated old issue'] })).toBe('')
    const units = weightedRecallQuery('checkout', 'alpha beta gamma delta epsilon zeta')
    const score = (term: string) =>
      units.reduce((n, x) => n + x.weight * tokenScore(x.token, (t) => t === term), 0)
    expect(score('checkout')).toBeGreaterThan(6 * score('alpha'))
    expect(
      recallQuery(
        recallExpansion('fix that too', { task: 'x '.repeat(2000), files: ['src/payment.ts'] })
      )
    ).toHaveLength(2)
  })
  it('excludes other-project sources from query expansion', () => {
    const store = storeWith([
      { ...message('other', 'foreignProject secret design'), contextProjectRoot: '/other' },
      { ...message('current', 'checkout receipt'), contextProjectRoot: '/current' }
    ])
    const expanded = store.queryExpansion(
      'thread',
      'same as before',
      {},
      { projectRoot: '/current' }
    )
    expect(expanded).toContain('checkout')
    expect(expanded).not.toContain('foreign')
  })
})
