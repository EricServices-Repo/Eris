import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
import { modelStreamWithAbort } from '../electron/main/services/task-deadline'
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
describe('abort-ignoring model transport', () => {
  it('releases the caller when the pending model step never settles', async () => {
    const controller = new AbortController()
    const source = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}) }) }
    const next = modelStreamWithAbort(source, controller.signal).next()
    const rejection = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort('timeout')
    await rejection
  })
  it('does not invoke a pre-cancelled adapter', async () => {
    const next = vi.fn()
    const controller = new AbortController()
    controller.abort('cancelled')
    const source = { [Symbol.asyncIterator]: () => ({ next }) }
    await expect(modelStreamWithAbort(source, controller.signal).next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(next).not.toHaveBeenCalled()
  })
})
describe('task meaning resolution', () => {
  it.each([undefined, 'cold-native-routing-skipped', 'remote-auto-routing-skipped'] as const)('preserves explicit file review without classifier inference (%s)', async skipInference => {
    model.response = 'invalid classifier response'
    const result = await resolveTaskDecision({...options(), fallback:'review', skipInference,
      text:'review the files, what else do we need to add for features?'})
    expect(result).toMatchObject({intent:'review',source:'bypass',rule:'workspace-inspection'})
    expect(model.requests).toHaveLength(0)
  })
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

describe('outcome review judges the workspace changes (#501)', () => {
  const editPlan: TurnPlan = {
    intent: 'edit', agentId: 'composer', agentName: 'Composer', mode: 'agent',
    models: { chat: 'local:test', tools: 'local:test' }, toolPolicy: 'edit',
    requiresTools: true, escalateToFull: false, reason: 'test', method: 'heuristic'
  }
  const HELLO = '<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n<button>Click me</button>\n</body>\n</html>\n'
  let ws = ''
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'eris-outcome-')))
  })
  const editTask = (text: string) => createTaskContract({ workspacePath: ws, text, plan: editPlan })
  const change = (path: string, excerpt = HELLO) => ({ path, op: 'create', excerpt })

  it('accepts three requested files written in this run without a model call', async () => {
    for (const name of ['index.html', 'about.html', 'contact.html']) writeFileSync(join(ws, name), HELLO)
    const task = editTask('Create index.html, about.html and contact.html')
    expect(task.requested?.targetFiles).toHaveLength(3)
    const verdict = await reviewTaskOutcome({
      ...options(), task, answer: 'Next, I will run a cat command to verify.', evidence: [],
      changes: ['index.html', 'about.html', 'contact.html'].map((path) => change(path))
    })
    expect(verdict).toEqual({ verdict: 'supported', reason: 'All requested files were written in this run.' })
    expect(model.requests).toHaveLength(0)
  })

  it('calls the model when a requested file was not written', async () => {
    writeFileSync(join(ws, 'index.html'), HELLO)
    model.response = '{"verdict":"partial","reason":"about.html was not created."}'
    const verdict = await reviewTaskOutcome({
      ...options(), task: editTask('Create index.html and about.html'), answer: 'Created index.html.', evidence: [],
      changes: [change('index.html')]
    })
    expect(verdict.verdict).toBe('partial')
    expect(model.requests).toHaveLength(1)
  })

  it('does not shortcut a requested file that fails the artifact parser', async () => {
    writeFileSync(join(ws, 'hello.html'), '<div><footer></div>')
    model.response = '{"verdict":"partial","reason":"broken"}'
    await reviewTaskOutcome({
      ...options(), task: editTask('Create hello.html'), answer: 'Created hello.html.', evidence: [],
      changes: [change('hello.html', '<div><footer></div>')]
    })
    expect(model.requests).toHaveLength(1)
  })

  it('puts the changes, not just the answer, in the review prompt', async () => {
    model.response = '{"verdict":"supported","reason":"hello.html has the heading and button."}'
    await reviewTaskOutcome({
      ...options(), task: editTask('Add a heading and a button to the page'), answer: 'I will run a cat command to verify.',
      evidence: [], changes: [change('hello.html')]
    })
    const messages = model.requests[0]!.messages as Array<{ role: string; content: string }>
    const report = JSON.parse(messages[1]!.content) as { changes: Array<{ path: string; op: string; excerpt: string }> }
    expect(report.changes).toEqual([{ path: 'hello.html', op: 'create', excerpt: HELLO }])
    expect(messages[0]!.content).toMatch(/workspace changes listed in `changes`/)
    expect(messages[0]!.content).toMatch(/the verdict is supported/)
  })
})

describe('OutcomeEvidence.changes (#501)', () => {
  const diff = (path: string, before: string | null, after: string, op: 'write' | 'delete' = 'write') =>
    ({ type: 'diff', diff: { checkpointId: 'c', opIndex: 0, path, before, after, op } }) as const

  it('keeps the latest state per file, and a created file stays created', async () => {
    const { OutcomeEvidence } = await import('../electron/main/services/chat-turn')
    const evidence = new OutcomeEvidence()
    evidence.observe(diff('hello.html', null, '<h1>v1</h1>'))
    evidence.observe(diff('hello.html', '<h1>v1</h1>', '<h1>v2</h1>'))
    evidence.observe(diff('style.css', 'a{}', 'b{}'))
    evidence.observe(diff('old.txt', 'x', '', 'delete'))
    expect(evidence.changes).toEqual([
      { path: 'hello.html', op: 'create', excerpt: '<h1>v2</h1>' },
      { path: 'style.css', op: 'modify', excerpt: 'b{}' },
      { path: 'old.txt', op: 'delete', excerpt: '' }
    ])
  })

  it('bounds the excerpt and the number of files', async () => {
    const { OutcomeEvidence } = await import('../electron/main/services/chat-turn')
    const evidence = new OutcomeEvidence()
    for (let i = 0; i < 9; i++) evidence.observe(diff(`f${i}.txt`, null, 'x'.repeat(5000)))
    expect(evidence.changes).toHaveLength(6)
    expect(evidence.changes[0]!.path).toBe('f3.txt')
    expect(evidence.changes[0]!.excerpt).toHaveLength(1500)
  })
})
