import { describe, expect, it } from 'vitest'

import { compactHistory } from '../electron/main/services/chat-prompt'
import { allocateContext, historyChars, RECALL_MAX_TOKENS } from '../src/shared/context-allocation'
import { ContextMemorySettingsSchema } from '../src/shared/context-memory'

const budget = (window: number) => Math.floor(window * 0.65)
const WINDOWS = [2_048, 8_192, 16_384, 32_768, 65_536, 131_072]
type History = Parameters<typeof compactHistory>[0]

const conversation = (count: number, chars: number): History =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    content: `${index} ${'x'.repeat(chars)}`
  }))

describe('allocateContext', () => {
  it('grows recall and history with the window', () => {
    for (const taskClass of ['agent', 'chat'] as const) {
      const [small, medium, large] = [8_192, 32_768, 65_536].map((window) =>
        allocateContext(budget(window), taskClass)
      )
      expect(medium!.recallTokens).toBeGreaterThan(small!.recallTokens)
      expect(large!.recallTokens).toBeGreaterThan(medium!.recallTokens)
      expect(medium!.historyTokens).toBeGreaterThan(small!.historyTokens)
      expect(large!.historyTokens).toBeGreaterThan(medium!.historyTokens)
    }
  })

  it('gives recall 15% of the input, where the old 1,024 was 19% of 8K and 2.4% of 64K', () => {
    expect(allocateContext(5_324, 'chat').recallTokens).toBe(798)
    expect(allocateContext(42_598, 'chat').recallTokens).toBe(6_389)
  })

  it('keeps roughly the old character budgets at the default window', () => {
    const chat = historyChars(allocateContext(budget(32_768), 'chat'))
    const agent = historyChars(allocateContext(budget(32_768), 'agent'))
    expect(chat).toBeGreaterThan(23_000)
    expect(chat).toBeLessThan(25_000)
    expect(agent).toBeGreaterThan(6_000)
    expect(agent).toBeLessThan(7_000)
  })

  it.each(WINDOWS)('leaves most of a %i window to current work', (window) => {
    for (const taskClass of ['agent', 'chat'] as const) {
      const input = budget(window)
      const allocation = allocateContext(input, taskClass)
      expect(allocation.freshEvidenceTokens).toBeGreaterThanOrEqual(input * 0.4)
      expect(
        allocation.recallTokens + allocation.historyTokens + allocation.freshEvidenceTokens
      ).toBe(input)
    }
  })

  it('holds its caps on a very large window', () => {
    const allocation = allocateContext(1_000_000, 'chat')
    expect(allocation.recallTokens).toBe(RECALL_MAX_TOKENS)
    expect(allocation.historyTokens).toBe(48_000)
  })

  it('applies floors without letting them take over a tiny window', () => {
    expect(allocateContext(5_000, 'agent').historyTokens).toBe(500)
    const tiny = allocateContext(400, 'chat')
    expect(tiny.recallTokens).toBe(100)
    expect(tiny.historyTokens).toBe(150)
  })

  it('lets a user ceiling lower recall but never raise it', () => {
    expect(allocateContext(42_598, 'chat', 512).recallTokens).toBe(512)
    expect(allocateContext(5_324, 'chat', 4_096).recallTokens).toBe(798)
  })

  it('never returns a negative or fractional budget', () => {
    expect(allocateContext(0, 'agent')).toMatchObject({
      recallTokens: 0,
      historyTokens: 0,
      freshEvidenceTokens: 0
    })
    expect(Number.isInteger(allocateContext(1234.7, 'chat').freshEvidenceTokens)).toBe(true)
  })

  it('defaults the setting to a ceiling that does not limit the allocation', () => {
    expect(ContextMemorySettingsSchema.parse({}).promptTokens).toBe(RECALL_MAX_TOKENS)
  })
})

describe('compactHistory by budget', () => {
  it('admits more messages on a larger window, not a fixed six', () => {
    const history = conversation(40, 500)
    const small = compactHistory(history, historyChars(allocateContext(budget(8_192), 'chat')))
    const large = compactHistory(history, historyChars(allocateContext(budget(65_536), 'chat')))
    expect(small.recent.length).toBeLessThan(large.recent.length)
    expect(large.recent.length).toBe(40)
  })

  it('never exceeds its budget', () => {
    for (const chars of [10, 300, 5_000, 40_000]) {
      const { recent } = compactHistory(conversation(60, chars), 6_000)
      const total = recent.reduce((sum, message) => sum + message.content.length, 0)
      expect(total).toBeLessThanOrEqual(6_000)
    }
  })

  it('always keeps both sides of the last exchanges', () => {
    const { recent } = compactHistory(conversation(30, 50_000), 1_200)
    expect(recent).toHaveLength(6)
    expect(new Set(recent.map((message) => message.role)).size).toBe(2)
  })

  it('covers exactly the sources it sent in full, so recall stays correct', () => {
    const history = conversation(30, 500)
    history[28]!.content = 'y'.repeat(20_000)
    const { recent, coveredSourceIds } = compactHistory(history, 12_000)
    const whole = recent.filter(
      (message) => history.find((m) => m.id === message.id)?.content === message.content
    )
    expect(coveredSourceIds).toEqual(whole.map((message) => message.id))
    expect(coveredSourceIds.length).toBeGreaterThan(0)
  })

  it('scales the older summary with the budget', () => {
    const history = conversation(400, 1_000)
    const short = compactHistory(history, 6_000).summary
    const long = compactHistory(history, 90_000).summary
    expect(short.length).toBeLessThanOrEqual(2_000)
    expect(long.length).toBeGreaterThan(short.length)
  })
})
