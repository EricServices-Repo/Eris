import { beforeEach, describe, expect, it, vi } from 'vitest'
const model = vi.hoisted(() => ({ response: '', stall: false, requests: [] as Array<Record<string, unknown>> }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: Record<string, unknown>) {
    model.requests.push(options)
    if (model.stall) await new Promise(() => {})
    yield model.response
  }
}))
import { resolveTaskIntent, resolveTaskDecision } from '../electron/main/services/task-resolver'
import { reviewTaskOutcome } from '../electron/main/services/task-outcome'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'
beforeEach(() => {
  model.requests.length = 0
  model.response = ''
  model.stall = false
})
const options = () => ({
  text: 'Could we make this easier to use?',
  fallback: 'edit' as const,
  model: 'local:test',
  mode: 'agent' as const,
  settings: getDefaults(),
  getSecret: () => null
})
describe('task meaning resolution', () => {
  it.each([undefined, 'cold-native-routing-skipped', 'remote-auto-routing-skipped'] as const)(
    'preserves referenced file generation with unavailable classifier (%s)', async skipInference => {
      model.response = 'malformed classification'
      const result = await resolveTaskDecision({ ...options(), skipInference,
        text: 'generate those files here in the project',
        history: [{ role: 'assistant', content: 'Create index.php, register.php, and calendar.php.' }]
      })
      expect(result).toMatchObject({ intent: 'edit', source: 'bypass', targetFiles: ['calendar.php', 'index.php', 'register.php'] })
      expect(model.requests).toHaveLength(0)
    }
  )
  it('keeps a missing file reference as unresolved requested work without inventing a plan', async () => {
    const resolution = await resolveTaskDecision({ ...options(), text: 'Generate those files here in the project' })
    expect(resolution).toMatchObject({ intent: 'edit', rule: 'missing-file-reference' })
    expect(model.requests).toHaveLength(0)
  })
  it('does not run semantic inference for an unavailable historical reference', async () => {
    expect(await resolveTaskDecision({ ...options(), reference: { status: 'unavailable', paths: [] } }))
      .toMatchObject({ rule: 'unresolved-reference' })
    expect(model.requests).toHaveLength(0)
  })
  it('uses structured interpretation for an ambiguous request without agent identity prompts', async () => {
    model.response = '{"intent":"review","confidence":0.95}'
    expect(await resolveTaskIntent(options())).toBe('review')
    expect(model.requests[0]?.tools).toBeUndefined()
    expect(model.requests[0]?.builtinJsonSchema).toBeDefined()
  })
  it('fails to a plan when an ambiguous mutation cannot be interpreted', async () => {
    model.response = 'Just overwrite the file.'
    expect(await resolveTaskIntent(options())).toBe('plan')
  })
  it('preserves explicit review and implementation requests without extra inference', async () => {
    expect(
      await resolveTaskIntent({
        ...options(),
        text: 'Review the code, improve it for the Airbnb website',
        fallback: 'review'
      })
    ).toBe('review')
    expect(await resolveTaskIntent({ ...options(), text: 'Implement those improvements' })).toBe(
      'edit'
    )
    expect(model.requests).toHaveLength(0)
  })
  it('keeps Ask mode from receiving a semantic execution decision', async () => {
    model.response = '{"intent":"edit","confidence":0.99}'
    expect(await resolveTaskIntent({ ...options(), mode: 'ask' })).toBe('explore')
  })
})
describe('semantic outcome check', () => {
  const plan: TurnPlan = {
    intent: 'review',
    agentId: 'reviewer',
    agentName: 'Reviewer',
    mode: 'agent',
    models: { chat: 'local:test', tools: 'local:test' },
    toolPolicy: 'read',
    requiresTools: true,
    escalateToFull: false,
    reason: 'test',
    method: 'heuristic'
  }
  const task = () =>
    createTaskContract({ workspacePath: null, text: 'Review booking behavior', plan })
  it('bounds an evaluator that ignores abort without claiming execution failed', async () => {
    model.stall = true
    const verdict = await reviewTaskOutcome({ ...options(), task: task(), answer: 'Reviewed booking behavior.', evidence: [], timeoutMs: 10 })
    expect(verdict).toMatchObject({ verdict: 'unresolved', failure: 'timeout' })
  })
  it('distinguishes malformed evaluator output from a valid partial verdict', async () => {
    model.response = 'not JSON'
    expect(await reviewTaskOutcome({ ...options(), task: task(), answer: 'Reviewed', evidence: [] }))
      .toMatchObject({ verdict: 'unresolved', failure: 'malformed-json' })
  })
  it('returns a bounded verdict from observed evidence without executing tools', async () => {
    model.response =
      '{"verdict":"supported","reason":"The finding identifies the unchecked booking date in the inspected source."}'
    const verdict = await reviewTaskOutcome({
      ...options(),
      task: task(),
      answer: 'booking.php accepts invalid dates',
      evidence: ['read_file booking.php: ok; no date validation']
    })
    expect(verdict.verdict).toBe('supported')
    expect(model.requests[0]?.tools).toBeUndefined()
  })
  it('retains uncertainty when a long answer was reviewed through obligation excerpts', async () => {
    model.response = '{"verdict":"supported","reason":"Selected excerpt looks complete"}'
    const verdict = await reviewTaskOutcome({
      ...options(),
      task: task(),
      answer: 'prefix '.repeat(20000) + ' booking dates are validated at the end',
      evidence: ['Inspected booking.php']
    })
    expect(verdict.verdict).toBe('unresolved')
    expect(verdict.coverage?.truncated).toBe(true)
    expect(verdict.coverage?.obligations.length).toBeGreaterThan(0)
  })
  it('marks an invalid evaluator response unresolved rather than treating it as success', async () => {
    model.response = '{"verdict":"done","reason":"Looks good"}'
    expect(
      (await reviewTaskOutcome({ ...options(), task: task(), answer: 'Done', evidence: [] }))
        .verdict
    ).toBe('unresolved')
  })
})
