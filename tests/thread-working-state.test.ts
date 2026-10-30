import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { emptyMemoryControls } from '../src/shared/context-memory'
import { expect, it } from 'vitest'
import { ThreadWorkingStateBuilder } from '../electron/main/services/thread-working-state'
import { createTaskContract } from '../electron/main/services/task-intake'
import { workingStateText } from '../src/shared/thread-working-state'
import { contextRecord } from '../src/shared/context-record'
const task = () =>
  createTaskContract({
    workspacePath: null,
    text: 'Implement login, fix search, and verify the booking tests',
    plan: {
      intent: 'edit',
      mode: 'agent',
      toolPolicy: 'full',
      agentId: 'composer',
      models: { chat: 'local:test', tools: 'local:test' }
    } as never
  })
it('keeps observed edits, failed checks and pending obligations independent of narrative completion', () => {
  const t = task(),
    b = new ThreadWorkingStateBuilder(t, 'reply')
  for (let i = 0; i < 2; i++)
    b.observe({
      type: 'diff',
      diff: {
        checkpointId: 'c',
        opIndex: i,
        path: `file${i}.ts`,
        before: 'old',
        after: 'new',
        op: 'write'
      }
    })
  b.observe({
    type: 'tool',
    tool: { id: 'test1', name: 'verify', path: 'npm test', status: 'error', detail: 'failure' }
  })
  b.observe({ type: 'answer', text: 'Everything is complete and tests passed.' })
  b.question('Which account provider?', false)
  const state = b.snapshot('stopped')
  expect(state.effects).toHaveLength(2)
  expect(state.checks[0].state).toBe('failed')
  expect(state.obligations.every((o) => o.state === 'pending')).toBe(true)
  expect(state).toMatchObject({
    taskId: t.taskId,
    taskRevision: t.revision,
    sourceMessageId: 'reply'
  })
  expect(workingStateText(state)).toContain('npm test: failed')
  expect(workingStateText(state)).toContain('Which account provider?')
  const message = contextRecord({
    id: 'reply',
    role: 'assistant',
    content: 'done',
    createdAt: 1,
    contextResult: {
      taskId: t.taskId,
      terminal: 'stopped',
      projectRoot: null,
      changedFiles: ['file0.ts', 'file1.ts'],
      workingState: state
    }
  })
  expect(message?.contextResult?.workingState).toEqual(state)
})
it('only a matching new check supersedes failure; later effects stale an earlier pass', () => {
  const b = new ThreadWorkingStateBuilder(task(), 'reply')
  b.observe({
    type: 'tool',
    tool: { id: 'a', name: 'verify', path: 'npm test', status: 'error', detail: 'fail' }
  })
  b.observe({
    type: 'tool',
    tool: { id: 'b', name: 'verify', path: 'npm run lint', status: 'ok', detail: 'pass' }
  })
  expect(b.snapshot('complete').checks[0].state).toBe('failed')
  b.observe({
    type: 'tool',
    tool: { id: 'c', name: 'verify', path: 'npm test', status: 'ok', detail: 'pass' }
  })
  b.observe({
    type: 'diff',
    diff: { checkpointId: 'c', opIndex: 0, path: 'app.ts', before: 'a', after: 'b', op: 'write' }
  })
  expect(b.snapshot('stopped').checks.every((c) => c.state === 'stale')).toBe(true)
})

it('makes typed pending state searchable even when the assistant reply only says done', async () => {
  const t = task(),
    b = new ThreadWorkingStateBuilder(t, 'reply')
  b.observe({
    type: 'tool',
    tool: { id: 'v', name: 'verify', path: 'npm test', status: 'error', detail: 'failed' }
  })
  const store = new ContextMemoryStore()
  const messages = [
    {
      id: 'reply',
      role: 'assistant' as const,
      content: 'Done.',
      createdAt: 1,
      contextResult: {
        taskId: t.taskId,
        terminal: 'stopped',
        projectRoot: null,
        changedFiles: [],
        workingState: b.snapshot('stopped')
      }
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content: 'unrelated conversation',
      createdAt: 1
    }))
  ]
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
  const resumed = await store.select('t', 'Continue where we left off; what remains?')
  expect(
    resumed.inspection.facts.some(
      (f) => f.kind === 'task-result' && f.text.includes('npm test: failed')
    )
  ).toBe(true)
  const result = await store.select('t', 'pending booking tests')
  expect(
    result.inspection.facts.some(
      (f) => f.kind === 'task-result' && f.text.includes('npm test: failed')
    )
  ).toBe(true)
})

it('never introduces sensitive task metadata into recalled working-state text', () => {
  const b = new ThreadWorkingStateBuilder(task(), 'reply')
  b.question('Should password=PRIVATE_SENTINEL be configured?', false)
  const text = workingStateText(b.snapshot('stopped'))
  expect(text).not.toContain('PRIVATE_SENTINEL')
  expect(text).toContain('withheld')
})
