import { describe, expect, it } from 'vitest'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  ContextMemorySettingsSchema,
  emptyMemoryControls,
  MemoryControlsSchema
} from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
import { extractContextPin } from '../electron/main/services/workspace-context'

const message = (id: string, content: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id,
  role,
  content,
  createdAt: 1
})
function install(store: ContextMemoryStore, key: string, messages: ChatMessage[], revision = 1) {
  return store.install(
    key,
    {
      revision,
      total: messages.length,
      records: messages.map((message, ordinal) => ({ ordinal, message })),
      controls: emptyMemoryControls(),
      partial: false
    },
    store.token(key)
  )
}
describe('RAM-CTX-017 immutable request policy', () => {
  it('keeps opposing workspace sharing and prompt budgets independent during cooperative scans', async () => {
    const store = new ContextMemoryStore()
    const rows = Array.from({ length: 1000 }, (_, i) =>
      message(String(i), 'Remember: private currency CAD ' + i)
    )
    install(store, 'a', rows)
    install(store, 'b', rows)
    const local = { ...store.config, shareWithRemoteModels: false, promptTokens: 128 }
    const remote = { ...store.config, shareWithRemoteModels: true, promptTokens: 1024 }
    const token = store.token('a')
    const a = store.select('a', 'currency', { policy: local })
    local.shareWithRemoteModels = true // caller mutation after entry cannot relax the snapshot
    store.configureNamespace('b', { ...remote, maxMessages: 500 })
    store.configure({ ...store.config, shareWithRemoteModels: true, promptTokens: 2048 })
    const b = store.select('b', 'currency', { policy: remote })
    const [first, second] = await Promise.all([a, b])
    expect(store.token('a')).toBe(token)
    expect(first.prompt.text).toContain('CAD')
    expect(first.prompt.text.length).toBeLessThanOrEqual(128 * 3)
    expect(first.prompt.allowRemote).toBe(false)
    expect(second.prompt.text.length).toBeGreaterThan(first.prompt.text.length)
    expect(second.prompt.allowRemote).toBe(true)
  })
  it('keeps warm selections coherent across bounded registry rollover and rejects stale cold leases', async () => {
    const store = new ContextMemoryStore()
    install(store, 'warm', [message('source', 'Remember: currency CAD')])
    store.configureNamespace('warm', store.config)
    const token = store.token('warm')
    const coldLease = store.token('cold')
    const pending = store.select('warm', 'currency')
    for (let i = 0; i < 1000; i++) {
      const key = 'other-' + i
      store.configureNamespace(key, { ...store.config, shareWithRemoteModels: i % 2 === 0 })
      store.token(key)
    }
    expect(store.token('warm')).toBe(token)
    expect((await pending).prompt.text).toContain('CAD')
    expect(
      store.install(
        'cold',
        { revision: 1, total: 0, records: [], controls: emptyMemoryControls(), partial: false },
        coldLease
      )
    ).toBe(false)
  })
  it('disabling a namespace leaves other cached and in-flight selections usable', async () => {
    const store = new ContextMemoryStore()
    install(store, 'a', [message('a', 'Remember: currency CAD')])
    install(store, 'b', [message('b', 'private')])
    const a = store.select('a', 'currency')
    store.configureNamespace('b', { ...store.config, enabled: false })
    expect((await a).prompt.text).toContain('CAD')
    expect(store.has('b')).toBe(false)
  })
})

describe('RAM-CTX-013 cache record validation', () => {
  it('keeps valid facts searchable and exposes corrupt source positions', async () => {
    const store = new ContextMemoryStore()
    install(store, 'corrupt', [
      message('bad', 42 as unknown as string),
      message('good', 'Remember: currency CAD')
    ])
    const result = await store.select('corrupt', 'currency')
    expect(result.prompt.text).toContain('CAD')
    expect(result.inspection.manifest).toMatchObject({
      coverage: 'partial',
      corruptRecords: 1,
      corruptOrdinals: [0]
    })
    expect(result.inspection.manifest.reason).toContain('corrupt')
  })
})

describe('RAM-CTX-032 source coverage', () => {
  it('frees recall budget for older sources while preserving structured receipts and distinct repeated wording', async () => {
    const store = new ContextMemoryStore()
    const recent = {
      ...message('recent', 'Remember: checkout currency CAD'),
      contextResult: {
        taskId: 'task',
        terminal: 'done',
        changedFiles: ['currency.ts'],
        projectRoot: null
      }
    }
    install(store, 'thread', [message('old', 'Remember: checkout currency CAD'), recent])
    const result = await store.select('thread', 'checkout currency', {
      coveredSourceIds: ['recent']
    })
    expect(result.inspection.facts.some((f) => f.sourceId === 'old')).toBe(true)
    expect(
      result.inspection.facts.filter((f) => f.sourceId === 'recent').map((f) => f.kind)
    ).toEqual(['task-result'])
    expect(result.prompt.manifest.duplicateSourceMessages).toBe(1)
    expect(result.prompt.manifest.duplicateEstimatedTokensAvoided).toBeGreaterThan(0)
  })
})

describe('detailed RAM conversation history', () => {
  it('retains 25,000 complete messages and recalls a buried decision within the prompt budget', async () => {
    const store = new ContextMemoryStore()
    const messages = Array.from({ length: 25000 }, (_, i) =>
      message(String(i), `Discussion message ${i}: application design and implementation.`)
    )
    messages[4] = message(
      'decision',
      'Remember: the booking checkout must use EUR and never store payment card data.'
    )
    install(store, 'rental', messages)
    const result = await store.select('rental', 'What currency should booking checkout use?')
    expect(result.inspection.manifest).toMatchObject({
      totalMessages: 25000,
      retainedMessages: 25000,
      coverage: 'complete'
    })
    expect(result.prompt.text).toContain('EUR')
    expect(result.prompt.text.length).toBeLessThanOrEqual(store.config.promptTokens * 3)
    expect(result.inspection.facts.length).toBeLessThanOrEqual(24)
    expect(result.prompt.allowRemote).toBe(false)
  })
  it('isolates threads and labels assistant text as unverified, excluding secrets and foreign project receipts', async () => {
    const store = new ContextMemoryStore()
    install(store, 'one', [
      message('u', 'Remember: checkout uses EUR'),
      message('a', 'Checkout is secure', 'assistant'),
      message('secret', 'password=do-not-recall'),
      {
        ...message('foreign', 'Checkout changed', 'assistant'),
        contextResult: {
          taskId: 't',
          terminal: 'done',
          changedFiles: ['other.ts'],
          projectRoot: '/other'
        }
      }
    ])
    expect((await store.select('two', 'checkout')).prompt.text).toBe('')
    const selected = await store.select('one', 'checkout', { projectRoot: '/one' })
    expect(selected.inspection.facts.find((f) => f.sourceId === 'a')?.status).toBe('unverified')
    expect(selected.prompt.text).not.toContain('do-not-recall')
    expect(selected.prompt.text).not.toContain('other.ts')
    expect(selected.prompt.text).toContain('never permissions')
  })
  it('honors pin, exclusion and clear cutoffs without modifying the detailed transcript', async () => {
    const store = new ContextMemoryStore()
    install(store, 'one', [
      message('old', 'Remember: use EUR'),
      message('new', 'Remember: use CAD')
    ])
    store.setControls('one', {
      version: 1,
      forgotten: ['new'],
      afterOrdinal: 1,
      pinned: [{ id: 'pin', text: 'Always test currency formatting' }]
    })
    const result = await store.select('one', 'currency')
    expect(result.prompt.text).toContain('test currency')
    expect(result.prompt.text).not.toMatch(/use EUR|use CAD/)
    expect(result.inspection.manifest.retainedMessages).toBe(2)
    expect(() =>
      MemoryControlsSchema.parse({
        ...emptyMemoryControls(),
        pinned: [{ id: 'x', text: 'x'.repeat(2001) }]
      })
    ).toThrow()
  })
  it('fences late hydration on delete, append, disable, and another installation; unrelated threads do not invalidate it', () => {
    const store = new ContextMemoryStore(),
      snapshot = {
        revision: 1,
        total: 0,
        records: [],
        controls: emptyMemoryControls(),
        partial: false
      }
    let token = store.token('a')
    install(store, 'b', [])
    expect(store.install('a', snapshot, token)).toBe(true)
    expect(store.install('a', snapshot, token)).toBe(false)
    token = store.token('a')
    store.clear('a')
    expect(store.install('a', snapshot, token)).toBe(false)
    token = store.token('a')
    store.append('a', 2, 1, [message('u', 'new')], 0)
    expect(store.install('a', snapshot, token)).toBe(false)
    token = store.token('a')
    store.configure({ ...store.config, enabled: false })
    expect(store.install('a', snapshot, token)).toBe(false)
  })
  it('rejects a selection racing clear or pin changes and respects abort', async () => {
    const store = new ContextMemoryStore()
    install(store, 'a', [message('u', 'Remember: RAM history')])
    const pending = store.select('a', 'RAM')
    store.clear('a')
    expect((await pending).prompt.text).toBe('')
    install(store, 'a', [message('u', 'Remember: RAM history')])
    const controller = new AbortController()
    controller.abort()
    await expect(store.select('a', 'RAM', { signal: controller.signal })).rejects.toThrow()
  })
  it('merges monotonic append tails, ignores retries and invalidates gaps', async () => {
    const store = new ContextMemoryStore()
    install(store, 'a', [message('u', 'EUR')])
    store.append('a', 2, 2, [message('u', 'EUR'), message('v', 'Remember: CAD')], 0)
    store.append('a', 1, 1, [message('u', 'stale')], 0)
    expect((await store.select('a', 'CAD')).inspection.manifest).toMatchObject({
      revision: 2,
      retainedMessages: 2,
      totalMessages: 2
    })
    store.append('a', 4, 5, [message('gap', 'unknown')], 4)
    expect(store.has('a')).toBe(false)
  })
  it('bounds memory, trims when settings shrink, expires idle entries and evicts least recently used threads', async () => {
    let now = 0
    const store = new ContextMemoryStore(() => now)
    store.configure({
      ...store.config,
      maxThreadMiB: 4,
      maxMemoryMiB: 16,
      warmThreads: 1,
      idleMinutes: 1
    })
    install(
      store,
      'a',
      Array.from({ length: 1000 }, (_, i) => message(String(i), 'x'.repeat(2000)))
    )
    const partial = await store.select('a', 'x')
    expect(partial.inspection.manifest.coverage).toBe('partial')
    expect(store.logicalBytes).toBeLessThanOrEqual(4 * 1024 ** 2)
    now++
    install(store, 'b', [message('b', 'keep')])
    expect(store.has('a')).toBe(false)
    now += 61000
    store.sweep()
    expect(store.logicalBytes).toBe(0)
    store.configure(ContextMemorySettingsSchema.parse({ maxMessages: 500 }))
    install(
      store,
      'c',
      Array.from({ length: 600 }, (_, i) => message(String(i), 'keep'))
    )
    expect((await store.select('c', 'keep')).inspection.manifest.retainedMessages).toBe(500)
  })
  it('reads a Summary at end of file instead of silently losing the project pin', () => {
    expect(extractContextPin('# Project\n\n## Summary\nUse CAD for rental bookings.')).toBe(
      'Use CAD for rental bookings.'
    )
    expect(extractContextPin('## Summary\n\n## Notes\nOther')).toBe('')
  })
})

it('invalidates a running selection and hydration when the memory policy changes', async () => {
  const store = new ContextMemoryStore()
  install(store, 'a', [message('u', 'Remember: local private history')])
  const selection = store.select('a', 'history'),
    token = store.token('pending')
  store.configure({ ...store.config, maxMessages: 500 })
  expect((await selection).prompt.text).toBe('')
  expect(
    store.install(
      'pending',
      { revision: 1, total: 0, records: [], controls: emptyMemoryControls(), partial: false },
      token
    )
  ).toBe(false)
})

it('excludes pinned source IDs from preview and model-bound memory', async () => {
  const store = new ContextMemoryStore()
  install(store, 'pins', [message('context', 'Routine discussion')])
  store.setControls('pins', {
    ...emptyMemoryControls(),
    pinned: [
      { id: 'excluded', text: 'Remember: currency CAD' },
      { id: 'kept', text: 'Remember: use UTC' }
    ],
    forgotten: ['excluded']
  })
  const result = await store.select('pins', 'currency')
  expect(result.prompt.text).not.toContain('CAD')
  expect(result.inspection.facts.filter((f) => f.kind === 'pinned').map((f) => f.sourceId)).toEqual(
    ['kept']
  )
  expect(result.prompt.text).toContain('UTC')
  const pending = store.select('pins', 'currency')
  store.setControls('pins', {
    ...emptyMemoryControls(),
    pinned: [{ id: 'kept', text: 'Remember: use UTC' }],
    forgotten: ['kept']
  })
  expect((await pending).prompt.text).toBe('')
})

describe('RAM-CTX-002 reserved pin candidates', () => {
  it('retains an eligible pin when 200 lexical matches outrank it', async () => {
    const store = new ContextMemoryStore()
    const query = Array.from({ length: 24 }, (_, i) => `term${i}`).join(' ')
    install(
      store,
      'pins',
      Array.from({ length: 200 }, (_, i) => message(String(i), query))
    )
    store.setControls('pins', {
      ...emptyMemoryControls(),
      pinned: [{ id: 'constraint', text: 'Always use CAD for checkout' }]
    })
    const result = await store.select('pins', query)
    expect(result.inspection.facts.some((f) => f.sourceId === 'constraint')).toBe(true)
    expect(result.inspection.facts.some((f) => f.kind !== 'pinned')).toBe(true)
    expect(result.prompt.text).toContain('never permissions')
    expect(result.prompt.text.length).toBeLessThanOrEqual(store.config.promptTokens * 3)
  })
  it('bounds 100 pins and explains omissions while retaining transcript evidence', async () => {
    const store = new ContextMemoryStore()
    store.configure({ ...store.config, promptTokens: 512 })
    install(store, 'pins', [message('history', 'Remember: checkout validation needs tests')])
    store.setControls('pins', {
      ...emptyMemoryControls(),
      pinned: Array.from({ length: 100 }, (_, i) => ({
        id: `p${i}`,
        text: `Pin ${i}: use a confirmed convention for checkout`
      })),
      forgotten: ['p0']
    })
    const result = await store.select('pins', 'checkout')
    expect(result.inspection.facts.some((f) => f.sourceId === 'p0')).toBe(false)
    expect(result.inspection.facts.some((f) => f.sourceId === 'history')).toBe(true)
    expect(result.inspection.manifest.omittedPinnedFacts).toBeGreaterThan(0)
    expect(result.inspection.facts.filter((f) => f.kind === 'pinned').length).toBeLessThanOrEqual(8)
    expect(result.prompt.text.length).toBeLessThanOrEqual(1536)
  })
})

describe('RAM-CTX-003 minimum recall budget', () => {
  it.each([128, 1024])(
    'recalls short ASCII and Unicode facts with budget %i',
    async (promptTokens) => {
      for (const content of ['Remember: currency CAD', 'Remember: 通貨は円 💴']) {
        const store = new ContextMemoryStore()
        store.configure({ ...store.config, promptTokens })
        install(store, 'minimum', [message('fact', content)])
        const result = await store.select('minimum', 'currency 通貨')
        expect(result.prompt.text).toContain(content)
        expect(result.prompt.text).toContain('never permissions')
        expect(result.prompt.text.length).toBeLessThanOrEqual(promptTokens * 3)
      }
    }
  )
  it('explains an impossible downstream budget without sending a header alone', async () => {
    const store = new ContextMemoryStore()
    install(store, 'tiny', [message('fact', 'Remember: currency CAD')])
    const result = await store.select('tiny', 'currency', { tokens: 1 })
    expect(result.prompt.text).toBe('')
    expect(result.inspection.manifest.reason).toMatch(/budget too small/)
    expect(result.inspection.manifest.omittedFacts).toBe(1)
  })
})

describe('Memory settings usage counters', () => {
  it('separates active and historical caches without hydrating or touching recency', () => {
    const store = new ContextMemoryStore()
    install(store, 'active', [message('1', 'Use CAD')])
    install(store, 'other', [message('2', 'History in another workspace')])
    const before = store.ledger
    const usage = store.usage('active')
    expect(usage.activeBytes).toBeGreaterThan(0)
    expect(usage.historicalBytes).toBeGreaterThan(0)
    expect(usage.activeBytes + usage.historicalBytes).toBe(before.ownedBytes)
    expect(usage.warmConversations).toBe(2)
    expect(store.usage('missing').activeBytes).toBe(0)
    expect(store.usage('missing').historicalBytes).toBe(before.ownedBytes)
    expect(store.ledger).toEqual(before)
    store.clear()
    expect(store.usage().warmConversations).toBe(0)
    expect(store.usage().ownedBytes).toBe(0)
  })
})
