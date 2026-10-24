import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * AG-078: a compact regression suite for the root causes found in
 * docs/reviews/eris-dev-10000-2026-10-23/improvements.json, plus a
 * deterministic sweep of the full corpus with exact denominators. The sweep
 * checks routing families only; it never grades answers.
 */

import { prepareQuestions } from '../electron/dev/questions'
import { classifyIntent, isErisCapabilityQuestion } from '../electron/main/services/chat-router'
import { conservativeFallback, resolveTaskDecision } from '../electron/main/services/task-resolver'
import {
  markSimulatedSettings,
  runInDiagnosticsScope,
  SIMULATED_MODEL_REF
} from '../electron/main/services/model-transport'
import { getDefaults } from '../electron/main/services/settings'
import { interpretRequest } from '../src/shared/task-interpretation'
import { asksForVerification, chatAgentForTurn } from '../src/shared/agent-contract'
import type { ChatIntent } from '../src/shared/settings-schema'
import type { IntentResolution } from '../src/shared/task-contract'

const corpus = prepareQuestions(
  readFileSync(join(__dirname, 'fixtures', '10000-natural-diverse-coding-questions.txt'), 'utf8'),
  '.txt',
  '10000-natural-diverse-coding-questions.txt'
)
const Q = (n: number) => corpus.questions[n - 1]!.text

interface Route {
  intent: ChatIntent
  artifact: string
  agent: string
  source: IntentResolution['source']
  rule: string
}

const settings = markSimulatedSettings(structuredClone(getDefaults()))

/**
 * FR-001: the route production takes when the semantic resolver gives no confident
 * answer. The real resolver runs, bypass precedence included, behind a scripted
 * transport that replies with zero confidence; nothing reaches a provider.
 */
async function productionRoute(text: string): Promise<Route> {
  const resolution = await runInDiagnosticsScope(
    {
      runId: 'regression-suite',
      mode: 'simulated',
      adapter: {
        kind: 'scripted',
        async *stream() {
          yield JSON.stringify({ intent: 'answer', confidence: 0 })
        }
      },
      onBlockedEffect: () => {}
    },
    () =>
      resolveTaskDecision({
        text,
        fallback: classifyIntent(text, 'agent'),
        settings,
        model: SIMULATED_MODEL_REF,
        mode: 'agent',
        getSecret: () => null
      })
  )
  const intent = resolution.intent
  return {
    intent,
    artifact: interpretRequest({ text, intent, canEdit: intent === 'edit', revision: 1 }).artifact,
    agent: chatAgentForTurn({ mode: 'agent', intent, text }),
    source: resolution.source,
    rule: resolution.rule
  }
}

/** The helper-only reconstruction the suite used before FR-001; a unit view, not a production metric. */
function helperRoute(text: string): ChatIntent {
  return conservativeFallback(text, classifyIntent(text, 'agent'))
}

const fallbackRoute = productionRoute

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
  it('Q2: a complete example is code, not a plan', async () => {
    expect(await fallbackRoute(Q(2))).toMatchObject({ intent: 'answer', artifact: 'code-example' })
  })
  it.each([6, 7, 34])(
    'Q%i: writing code in chat is not a mutation or a three-sentence lookup',
    async (n) => {
      const route = await fallbackRoute(Q(n))
      expect(['answer', 'explore']).toContain(route.intent)
      expect(route.agent).not.toBe('fast')
    }
  )
  it.each([42, 111, 524])('Q%i: feature nouns are not a verification request', async (n) => {
    expect((await fallbackRoute(Q(n))).intent).not.toBe('verify')
  })
  it.each([2813, 8123, 8882])(
    'Q%i: an application data model is not the model catalog',
    async (n) => {
      expect(isErisCapabilityQuestion(Q(n))).toBe(false)
      expect(await fallbackRoute(Q(n))).toMatchObject({ artifact: 'design' })
    }
  )
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
  it('an explicit plan request stays a plan; a complete example does not', async () => {
    expect((await fallbackRoute('Give me an implementation plan for soft deletes')).artifact).toBe(
      'plan'
    )
    expect((await fallbackRoute(Q(2))).artifact).toBe('code-example')
  })
  it('a named file makes a patch; a shown function stays in chat', async () => {
    expect(
      interpretRequest({
        text: 'Add the function to src/api.ts',
        intent: 'edit',
        canEdit: true,
        revision: 1
      }).destination
    ).toBe('workspace')
    expect((await fallbackRoute('Show a function that slugifies titles')).artifact).toBe(
      'code-example'
    )
    // The production resolver keeps edit authority for a named destination.
    expect(await fallbackRoute('Add the slugify function to src/api.ts')).toMatchObject({
      intent: 'edit',
      source: 'bypass'
    })
  })
})

describe('full corpus sweep through the production resolver', () => {
  let routes: Array<Route & { text: string; helper: ChatIntent }> = []
  beforeAll(async () => {
    routes = []
    for (const question of corpus.questions)
      routes.push({
        text: question.text,
        helper: helperRoute(question.text),
        ...(await productionRoute(question.text))
      })
  }, 120_000)
  const count = (predicate: (route: (typeof routes)[number]) => boolean) =>
    routes.filter(predicate).length

  it('records a resolution source for every case', () => {
    expect(routes).toHaveLength(10000)
    const sources = Object.fromEntries(
      (['bypass', 'semantic', 'fallback', 'forced'] as const).map((source) => [
        source,
        count((route) => route.source === source)
      ])
    )
    expect(Object.values(sources).reduce((sum, value) => sum + value, 0)).toBe(10000)
    // No semantic reply is confident, so every case is either a bypass or a fallback.
    expect(sources.semantic + sources.forced).toBe(0)
  })

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
    // Without a semantic decision, no corpus question is given edit or run effects,
    // bypass included. Before FR-002 production gave 134 of them a patch.
    expect(
      routes
        .filter((route) => route.intent === 'edit' || route.intent === 'run')
        .map((route) => `${route.source}:${route.rule} ${route.text}`)
    ).toEqual([])
  })

  it('publishes where the helper reconstruction and production disagree', () => {
    // The helper is a unit view. Any disagreement is listed, never folded into a green total.
    const differences = routes.filter((route) => route.helper !== route.intent)
    expect(differences.map((route) => `${route.helper} → ${route.intent}: ${route.text}`)).toEqual(
      []
    )
  })
})

describe('FR-002 production-boundary contrast cases', () => {
  it.each([
    [107, 'answer', 'code-example'],
    [413, 'answer', 'code-example']
  ] as const)('Q%i asks for code in chat, not a patch', async (n, intent, artifact) => {
    expect(await productionRoute(Q(n))).toMatchObject({ intent, artifact })
  })
  it.each([
    ['Add input validation to src/api.ts', 'edit', 'patch'],
    ['Fix the login redirect bug', 'edit', 'patch'],
    ['Build a new todo app here from scratch', 'edit', 'patch'],
    ['Write a TypeScript example of a debounce function', 'answer', 'code-example'],
    ['How would you approach caching for this API?', 'answer', 'design'],
    // LR-004: “write” binds to the behavior; no artifact noun is needed.
    ['Can you write feature flags so errors are explicit?', 'answer', 'code-example'],
    ['Can you fix the failing login test?', 'edit', 'patch']
  ] as const)('“%s” → %s / %s', async (text, intent, artifact) => {
    expect(await productionRoute(text)).toMatchObject({ intent, artifact })
  })
})
