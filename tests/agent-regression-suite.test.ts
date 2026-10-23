import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * AG-078: a compact regression suite for the root causes found in
 * docs/reviews/eris-dev-10000-2026-10-23/AGENT-IMPROVEMENTS.md, plus a
 * deterministic sweep of the full corpus with exact denominators. The sweep
 * checks routing families only; it never grades answers.
 */

import { prepareQuestions } from '../electron/dev/questions'
import { classifyIntent, isErisCapabilityQuestion } from '../electron/main/services/chat-router'
import { conservativeFallback } from '../electron/main/services/task-resolver'
import { interpretRequest } from '../src/shared/task-interpretation'
import { asksForVerification, chatAgentForTurn } from '../src/shared/agent-contract'
import type { ChatIntent } from '../src/shared/settings-schema'

const corpus = prepareQuestions(
  readFileSync(join(__dirname, 'fixtures', '10000-natural-diverse-coding-questions.txt'), 'utf8'),
  '.txt',
  '10000-natural-diverse-coding-questions.txt'
)
const Q = (n: number) => corpus.questions[n - 1]!.text

/** The route a turn takes when the semantic resolver gives no confident answer. */
function fallbackRoute(text: string): { intent: ChatIntent; artifact: string; agent: string } {
  const intent = conservativeFallback(text, classifyIntent(text, 'agent'))
  return {
    intent,
    artifact: interpretRequest({ text, intent, canEdit: intent === 'edit', revision: 1 }).artifact,
    agent: chatAgentForTurn({ mode: 'agent', intent, text })
  }
}

describe('corpus import', () => {
  it('normalizes the numbered file with its heading to exactly 10,000 questions', () => {
    expect(corpus.questions).toHaveLength(10000)
    expect(corpus.excluded).toHaveLength(3)
    expect(new Set(corpus.questions.map((question) => question.id)).size).toBe(10000)
    expect(Q(2)).toBe(
      'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?'
    )
  })
})

describe('named regressions', () => {
  it('Q2: a complete example is code, not a plan', () => {
    expect(fallbackRoute(Q(2))).toMatchObject({ intent: 'answer', artifact: 'code-example' })
  })
  it.each([6, 7, 34])('Q%i: writing code in chat is not a mutation or a three-sentence lookup', (n) => {
    const route = fallbackRoute(Q(n))
    expect(['answer', 'explore']).toContain(route.intent)
    expect(route.agent).not.toBe('fast')
  })
  it.each([42, 111, 524])('Q%i: feature nouns are not a verification request', (n) => {
    expect(fallbackRoute(Q(n)).intent).not.toBe('verify')
  })
  it.each([2813, 8123, 8882])('Q%i: an application data model is not the model catalog', (n) => {
    expect(isErisCapabilityQuestion(Q(n))).toBe(false)
    expect(fallbackRoute(Q(n))).toMatchObject({ artifact: 'design' })
  })
})

describe('contrast pairs', () => {
  it.each([
    ['Verify this implementation', 111],
    ['Check that the fix works', 524]
  ] as const)('“%s” is verification; Q%i is not', (verify, n) => {
    expect(asksForVerification(verify)).toBe(true)
    expect(asksForVerification(Q(n))).toBe(false)
  })
  it('the catalog question stays a capability question', () => {
    expect(isErisCapabilityQuestion('Which models are installed in Eris?')).toBe(true)
    expect(isErisCapabilityQuestion(Q(2813))).toBe(false)
  })
  it('an explicit plan request stays a plan; a complete example does not', () => {
    expect(fallbackRoute('Give me an implementation plan for soft deletes').artifact).toBe('plan')
    expect(fallbackRoute(Q(2)).artifact).toBe('code-example')
  })
  it('a named file makes a patch; a shown function stays in chat', () => {
    expect(
      interpretRequest({ text: 'Add the function to src/api.ts', intent: 'edit', canEdit: true, revision: 1 })
        .destination
    ).toBe('workspace')
    expect(fallbackRoute('Show a function that slugifies titles').artifact).toBe('code-example')
  })
})

describe('full corpus sweep', () => {
  const routes = corpus.questions.map((question) => ({
    text: question.text,
    ...fallbackRoute(question.text)
  }))
  const count = (predicate: (route: (typeof routes)[number]) => boolean) =>
    routes.filter(predicate).length

  it('has no capability or verification collisions in the known families', () => {
    const family = (pattern: RegExp) => routes.filter((route) => pattern.test(route.text))
    const minimal = family(/^Can you generate a minimal/)
    const dataModel = family(/^How would you design the data model and API/)
    const healthChecks = family(/health checks that verify downstream/)
    const seeding = family(/seeding realistic test data/)
    // Exact denominators from the review.
    expect([minimal.length, dataModel.length]).toEqual([225, 40])
    expect(minimal.filter((route) => route.intent === 'answer')).toHaveLength(225)
    expect(dataModel.filter((route) => route.intent === 'capability')).toHaveLength(0)
    expect(healthChecks.filter((route) => route.intent === 'verify')).toHaveLength(0)
    expect(seeding.filter((route) => route.intent === 'verify')).toHaveLength(0)
  })

  it('reports the route distribution with an exact denominator', () => {
    const intents = Object.fromEntries(
      (['answer', 'explore', 'plan', 'verify', 'edit', 'review', 'run', 'capability'] as const).map(
        (intent) => [intent, count((route) => route.intent === intent)]
      )
    )
    expect(Object.values(intents).reduce((sum, value) => sum + value, 0)).toBe(10000)
    expect(intents.capability).toBe(0)
    expect(intents.verify).toBe(0)
    // Without a semantic decision, no corpus question is given edit or run effects.
    expect(intents.edit + intents.run).toBe(0)
  })
})
