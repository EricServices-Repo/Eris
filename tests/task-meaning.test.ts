import { beforeEach, describe, expect, it, vi } from 'vitest'
const model = vi.hoisted(() => ({ response: '', requests: [] as Array<Record<string, unknown>> }))
vi.mock('../electron/main/services/chat-runtime', () => ({
  streamModelChat: async function* (options: Record<string, unknown>) {
    model.requests.push(options)
    yield model.response
  }
}))
import { resolveTaskIntent } from '../electron/main/services/task-resolver'
import { reviewTaskOutcome } from '../electron/main/services/task-outcome'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import type { TurnPlan } from '../src/shared/settings-schema'
beforeEach(() => {
  model.requests.length = 0
  model.response = ''
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
  it('marks an invalid evaluator response unresolved rather than treating it as success', async () => {
    model.response = '{"verdict":"done","reason":"Looks good"}'
    expect(
      (await reviewTaskOutcome({ ...options(), task: task(), answer: 'Done', evidence: [] }))
        .verdict
    ).toBe('unresolved')
  })
})
