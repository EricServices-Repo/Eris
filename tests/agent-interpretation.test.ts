import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Stage 2 of docs/reviews/eris-dev-10000-2026-10-23/improvements.json:
 * requested artifacts separate from effects (AG-003–012) and resolver
 * tracing, validation and precedence (AG-013–022).
 */

const model = vi.hoisted(() => ({
  reply: '' as string | ((signal: AbortSignal) => Promise<string>),
  calls: 0
}))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: { signal: AbortSignal }) {
    model.calls++
    yield typeof model.reply === 'string' ? model.reply : await model.reply(options.signal)
  }
}))

import {
  artifactResponseContract,
  forbidsMutation,
  interpretRequest,
  requestedLanguage,
  requestedFrameworks
} from '../src/shared/task-interpretation'
import {
  classifyIntent,
  classifyIntentTraced,
  planChatTurn
} from '../electron/main/services/chat-router'
import { resolveTaskDecision, resolverBypassRule } from '../electron/main/services/task-resolver'
import { createTaskContract } from '../electron/main/services/task-intake'
import { interpretationOf, taskContractConflicts } from '../src/shared/task-contract'
import { getDefaults } from '../electron/main/services/settings'
import type { ChatIntent, TurnPlan } from '../src/shared/settings-schema'

const Q2 =
  'Can you generate a minimal but complete example of soft deletes with the ability to restore in TypeScript?'
const Q7 = 'Can you write a clear Java version of generating image thumbnails on the fly?'
const Q111 =
  'Show me an example of health checks that verify downstream dependencies inside a Django project?'
const Q524 =
  'Write a TypeScript implementation of seeding realistic test data that prioritizes clarity?'
const Q2813 =
  'How would you design the data model and API for infinite scroll using cursor pagination?'

beforeEach(() => {
  model.reply = ''
  model.calls = 0
})

const interpret = (text: string, intent: ChatIntent, canEdit = false) =>
  interpretRequest({ text, intent, canEdit, revision: 1 })

const decide = (text: string, fallback: ChatIntent, extra: Record<string, unknown> = {}) =>
  resolveTaskDecision({
    text,
    fallback,
    settings: getDefaults(),
    model: 'local:test',
    mode: 'agent',
    getSecret: () => null,
    ...extra
  })

const plan = (overrides: Partial<TurnPlan>): TurnPlan => ({
  intent: 'answer',
  agentId: 'explainer',
  agentName: 'Explainer',
  mode: 'agent',
  models: { chat: 'local:test', tools: 'local:test' },
  toolPolicy: 'none',
  requiresTools: false,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic',
  ...overrides
})

describe('AG-003/AG-004 requested artifact and destination', () => {
  it('separates a chat code example from a workspace patch', () => {
    expect(
      interpret('Generate a complete TypeScript example of a retry helper', 'answer')
    ).toMatchObject({
      artifact: 'code-example',
      destination: 'chat',
      language: 'TypeScript'
    })
    expect(interpret('Apply it in src/auth.ts', 'edit', true)).toMatchObject({
      artifact: 'patch',
      destination: 'workspace'
    })
  })

  it('keeps show, add-to-file and new-app requests distinct', () => {
    expect(interpret('Show a function that slugifies titles', 'answer').destination).toBe('chat')
    expect(interpret('Add the slugify function to api.ts', 'edit', true).destination).toBe(
      'workspace'
    )
    expect(interpret('Build a new app here for tracking habits', 'edit', true).destination).toBe(
      'new-project'
    )
  })

  it('never puts a workspace destination on a contract without edit authority', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Add the slugify function to api.ts',
      plan: plan({ intent: 'edit', toolPolicy: 'read' })
    })
    expect(interpretationOf(task).destination).toBe('chat')
    expect(taskContractConflicts(task)).toEqual([])
  })

  it('defaults legacy contracts from their deliverable', () => {
    const task = createTaskContract({
      workspacePath: null,
      text: 'Review auth',
      plan: plan({ intent: 'review', toolPolicy: 'read' })
    })
    const legacy = { ...task, interpretation: undefined }
    expect(interpretationOf(legacy)).toMatchObject({ artifact: 'review', destination: 'chat' })
  })
})

describe('AG-010/AG-033 combined requests keep every obligation', () => {
  it('tracks implementation and tests separately', () => {
    const text = 'Write the core logic and the tests for per-user rate limiting in Python'
    const reading = interpret(text, 'answer')
    expect(reading.obligations.map((o) => o.kind)).toEqual(['implementation', 'tests'])
    const task = createTaskContract({ workspacePath: null, text, plan: plan({}) })
    expect(task.acceptanceCriteria.some((c) => /complete Python example/.test(c))).toBe(true)
    expect(task.acceptanceCriteria.some((c) => /tests/i.test(c))).toBe(true)
  })

  it('does not invent a tests obligation', () => {
    expect(interpret(Q2, 'answer').obligations.map((o) => o.kind)).toEqual(['implementation'])
  })
})

describe('AG-011 plan route needs a planning deliverable', () => {
  it('distinguishes advice, plans and code under the plan route', () => {
    expect(interpret('What is the best way to structure feature flags?', 'plan').artifact).toBe(
      'design'
    )
    expect(interpret('Give me an implementation plan for feature flags', 'plan').artifact).toBe(
      'plan'
    )
    expect(interpret(Q2, 'plan').artifact).toBe('code-example')
  })
})

describe('AG-031 language and framework are structured fields', () => {
  it('extracts the requested stack', () => {
    expect(requestedLanguage(Q7)).toBe('Java')
    expect(requestedLanguage(Q111)).toBe('Python')
    expect(requestedFrameworks(Q111)).toEqual(['Django'])
    expect(requestedLanguage('Explain JavaScript closures')).toBe('JavaScript')
    expect(requestedLanguage('How do I go about caching?')).toBeNull()
  })

  it('keeps the requested stack in the response contract', () => {
    const contract = artifactResponseContract(interpret(Q7, 'answer'))
    expect(contract).toContain('code example')
    expect(contract).toContain('Use Java as requested')
    expect(contract).not.toMatch(/sentence limit;?\s*$/)
  })
})

describe('AG-013/AG-014 resolver and route traces', () => {
  it('explains a fallback downgrade instead of claiming the heuristic was retained', async () => {
    model.reply = 'not json'
    const decision = await decide(Q2, 'edit')
    expect(decision).toMatchObject({
      intent: 'answer',
      initialIntent: 'edit',
      source: 'fallback',
      failure: 'malformed-json',
      downgrade: { from: 'edit', to: 'answer', rule: 'edit-to-code-example-answer' }
    })
    model.reply = 'not json'
    expect((await decide('Could we make this easier to use?', 'edit')).downgrade?.rule).toBe(
      'edit-to-plan'
    )
  })

  it('records the classifier rule and overrides on the plan', async () => {
    const routed = (text: string) =>
      planChatTurn({
        workspacePath: null,
        settings: structuredClone(getDefaults()),
        getSecret: () => null,
        context: { text, selectedModel: 'local:test', mode: 'agent', skipModelRouter: true }
      })
    expect((await routed(Q524)).routeTrace?.heuristicRule).not.toBe('explicit-verification')
    expect((await routed(Q2813)).routeTrace?.heuristicRule).not.toBe('capability-question')
    expect((await routed('Verify this implementation')).routeTrace?.heuristicRule).toBe(
      'explicit-verification'
    )
    const resolved = await planChatTurn({
      workspacePath: null,
      settings: structuredClone(getDefaults()),
      getSecret: () => null,
      context: {
        text: 'Verify this implementation',
        selectedModel: 'local:test',
        mode: 'agent',
        skipModelRouter: true,
        resolvedIntent: 'explore'
      }
    })
    expect(resolved.routeTrace).toMatchObject({ heuristicRule: 'resolved-intent' })
    expect(resolved.routeTrace?.overrides).not.toContain('explicit-specialist:verify')
  })
})

describe('AG-015 resolver bypasses', () => {
  it('records which shortcut was taken and lets feature nouns reach the resolver', () => {
    expect(resolverBypassRule(Q524, 'edit')).not.toBe('explicit-verification')
    expect(resolverBypassRule(Q111, 'explore')).toBeNull()
    expect(resolverBypassRule('Fix the login redirect bug', 'edit')).toBe('imperative')
    expect(resolverBypassRule('Verify this implementation', 'verify')).toBe('explicit-verification')
  })

  it('skips inference for a clear command', async () => {
    const decision = await decide('Fix the login redirect bug', 'edit')
    expect(decision).toMatchObject({ source: 'bypass', rule: 'imperative', intent: 'edit' })
    expect(model.calls).toBe(0)
  })
})

describe('AG-017 resolver latency is bounded and measured', () => {
  it('falls back with a timeout reason inside the budget', async () => {
    model.reply = (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      )
    const decision = await decide('Could we make this easier to use?', 'edit', { timeoutMs: 30 })
    expect(decision).toMatchObject({ source: 'fallback', failure: 'timeout', intent: 'plan' })
    expect(decision.durationMs).toBeLessThan(1000)
  })

  it('propagates user cancellation', async () => {
    const controller = new AbortController()
    model.reply = (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      )
    const pending = decide('Could we make this easier to use?', 'edit', {
      signal: controller.signal
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('AG-018 resolver replies are validated at runtime', () => {
  it.each([
    ['{"intent":"deploy","confidence":0.9}', 'schema-invalid'],
    ['{"intent":"review","confidence":1.5}', 'schema-invalid'],
    ['{"intent":"review","confidence":0.95,"agent":"composer"}', 'schema-invalid'],
    ['{"intent":"review","confidence":"high"}', 'schema-invalid'],
    ['{"intent":"review","confidence":0.5}', 'low-confidence'],
    ['{intent: review}', 'malformed-json']
  ])('rejects %s as %s with no wider effects', async (reply, failure) => {
    model.reply = reply
    const decision = await decide('Could we make this easier to use?', 'edit')
    expect(decision).toMatchObject({ source: 'fallback', failure, intent: 'plan' })
  })

  it('accepts a valid confident interpretation', async () => {
    model.reply = '{"intent":"review","confidence":0.95}'
    expect(await decide('Could we make this easier to use?', 'edit')).toMatchObject({
      source: 'semantic',
      intent: 'review',
      confidence: 0.95
    })
  })
})

describe('AG-021 quoted text and negation guards', () => {
  it('keeps “do not edit” requests read-only even with edit verbs', () => {
    const text = 'Explain why the string write_file appears here; do not edit'
    expect(forbidsMutation(text)).toBe(true)
    expect(classifyIntentTraced(text, 'agent')).toMatchObject({
      intent: 'explore',
      rule: expect.stringMatching(/^negated-mutation:/)
    })
    const task = createTaskContract({
      workspacePath: null,
      text,
      plan: plan({ intent: 'edit', toolPolicy: 'edit', agentId: 'composer' })
    })
    expect(task.authority.edit).toBe(false)
    expect(task.authority.execute).toBe('none')
    expect(taskContractConflicts(task)).toEqual([])
  })

  it('ignores commands inside quotes and code fences', () => {
    expect(classifyIntent('What does "npm run build" print in the README?', 'agent')).not.toBe(
      'run'
    )
    expect(
      classifyIntent(
        'What does this comment mean?\n```\n// TODO: fix the bug and deploy\n```',
        'agent'
      )
    ).not.toBe('edit')
    expect(classifyIntent('Fix the bug in src/app.ts', 'agent')).toBe('edit')
  })
})

describe('AG-022 confidence never grants effects on its own', () => {
  it('downgrades a confident edit for a question or a no-edit request', async () => {
    model.reply = '{"intent":"edit","confidence":0.99}'
    expect(await decide('How should we add caching to the API?', 'explore')).toMatchObject({
      intent: 'explore',
      downgrade: { from: 'edit', rule: 'question-needs-explicit-edit' }
    })
    model.reply = '{"intent":"edit","confidence":0.99}'
    expect(
      (await decide('Look over the caching layer, but do not change anything', 'explore')).intent
    ).toBe('explore')
  })
})
