import { describe, expect, it } from 'vitest'
import { RunJournal, searchTerms } from '../electron/main/services/agent/run-journal'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { ContextMemorySettingsSchema } from '../src/shared/context-memory'

describe('run-journal search terms keep exact identifiers (#267)', () => {
  it('keeps a compound identifier whose parts include one character', () => {
    expect(searchTerms('PLANTED-FACT-0')).toEqual(['planted-fact-0', 'planted', 'fact'])
    expect(searchTerms('upgrade to v1.2 now')).toContain('v1.2')
    expect(searchTerms('error-5 again')).toContain('error-5')
    // No one-character part: the words already identify it, so nothing is added.
    expect(searchTerms('src/auth/login.ts')).toEqual(['src', 'auth', 'login', 'ts'])
  })

  it('joins a lone digit to its neighbours as phrases', () => {
    expect(searchTerms('which test 3 failed')).toEqual([
      'test 3',
      '3 failed',
      'which',
      'test',
      'failed'
    ])
    expect(searchTerms('3')).toEqual([])
  })

  it('keeps identifiers when the query has more than sixteen words', () => {
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    const terms = searchTerms(`${many} FACT-7`)
    expect(terms).toHaveLength(16)
    expect(terms[0]).toBe('fact-7')
  })

  it.each([
    ['PLANTED-FACT-1', 'PLANTED-FACT-'],
    ['test 3', 'test '],
    ['error 5', 'error ']
  ])('ranks the entry with %s first among siblings', async (query, stem) => {
    const store = new ContextMemoryStore()
    store.configure(ContextMemorySettingsSchema.parse({}))
    const journal = new RunJournal({ runId: 'r', taskId: 't', memoryKey: 'k' }, store)
    try {
      // The sought entry is the oldest, so newest-first tie-breaking cannot favour it.
      for (const n of [query.at(-1), '0', '2', '4', '6'])
        await journal.append({
          toolName: 'run',
          toolCallId: `c${n}`,
          args: {},
          content: `log line\n${stem}${n} result recorded\nmore output`
        })
      const hits = await journal.search(query, 5)
      expect(hits[0]?.snippet).toContain(query)
    } finally {
      journal.close()
    }
  })
})
