import { ChatDatabase } from '../electron/main/services/chat-database'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { declaredDecisions } from '../electron/main/services/context-decisions'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
const m = (
  id: string,
  content: string,
  scope: string | null = '/a',
  role: ChatMessage['role'] = 'user'
): ChatMessage => ({ id, role, content, createdAt: 1, contextProjectRoot: scope })
function install(messages: ChatMessage[]) {
  const store = new ContextMemoryStore()
  store.install(
    't',
    {
      revision: 1,
      total: messages.length,
      records: messages.map((message, ordinal) => ({ ordinal, message })),
      controls: emptyMemoryControls(),
      partial: false
    },
    store.token('t')
  )
  return store
}
it('selects an explicit newer correction and suppresses the superseded source', async () => {
  const store = install([
    m('old', 'Remember: booking currency = USD'),
    ...Array.from({ length: 40 }, (_, i) => m(String(i), 'unrelated text')),
    m('new', 'Correction: booking currency = CAD instead of USD')
  ])
  const result = await store.select('t', 'current booking currency', { projectRoot: '/a' })
  expect(result.prompt.text).toContain('booking currency = CAD')
  expect(result.prompt.text).not.toContain('USD')
  expect(result.inspection.facts.find((f) => f.kind === 'decision')).toMatchObject({
    sourceId: 'new',
    status: 'active'
  })
  store.setControls('t', { ...emptyMemoryControls(), forgotten: ['new'] })
  expect((await store.select('t', 'currency', { projectRoot: '/a' })).prompt.text).not.toContain(
    'USD'
  )
})
it('keeps scopes independent, exposes ambiguity and never lets assistant prose supersede user choices', async () => {
  const store = install([
    m('a', 'Decision: currency = USD'),
    m('b', 'Correction: currency = CAD', '/b'),
    m('assistant', 'Correction: currency = EUR', '/a', 'assistant'),
    m('ambiguous', 'Remember: currency = GBP')
  ])
  const a = await store.select('t', 'currency', { projectRoot: '/a' })
  expect(
    a.inspection.facts.filter((f) => f.kind === 'decision').every((f) => f.status === 'disputed')
  ).toBe(true)
  expect(a.prompt.text).not.toContain('currency = CAD')
  const b = await store.select('t', 'currency', { projectRoot: '/b' })
  expect(b.inspection.facts.find((f) => f.kind === 'decision')).toMatchObject({
    sourceId: 'b',
    status: 'active'
  })
})
it('does not extract quotes, fenced code, negated or uncertain statements as active decisions', () => {
  for (const text of [
    '> Remember: currency = USD',
    'Remember: currency is not USD',
    'Maybe remember: currency = USD',
    'Remember: currency = "USD"',
    '```\nRemember: currency = USD\n```'
  ])
    expect(declaredDecisions(m('u', text))).toEqual([])
})

it('persists main-resolved scope without changing source identity or user content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eris-decisions-')),
    db = new ChatDatabase(dir)
  try {
    db.save({
      id: 't',
      title: 'History',
      model: 'local:test',
      createdAt: 1,
      updatedAt: 1,
      messages: [m('user', 'Decision: currency = CAD', null)]
    })
    const before = db.contextHeader('t')!
    expect(db.scopeContextSource('t', 'user', '/a')).toBe(true)
    expect(db.scopeContextSource('t', 'user', '/a')).toBe(false)
    const source = db.contextPage('t')!.records[0].message
    expect(source).toMatchObject({
      id: 'user',
      content: 'Decision: currency = CAD',
      contextProjectRoot: '/a'
    })
    expect(db.contextHeader('t')!.revision).toBeGreaterThan(before.revision)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
