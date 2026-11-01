import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { compileTaskContext } from '../electron/main/services/agent/context-compiler'
import { childTaskContract, createTaskContract } from '../electron/main/services/task-intake'
import { interpretationOf, type TaskContract } from '../src/shared/task-contract'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'eris-child-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const plan = (intent = 'edit', toolPolicy = 'edit') =>
  ({
    mode: 'agent',
    intent,
    toolPolicy,
    agentId: 'composer',
    agentName: 'Composer',
    models: { chat: 'local:t', tools: 'local:t' }
  }) as never
const parentOf = (text: string, intent?: string, policy?: string) =>
  createTaskContract({ workspacePath: root, text, plan: plan(intent, policy) })
const childOf = (parent: TaskContract, goal: string, intent?: string, policy?: string) =>
  childTaskContract(parent, plan(intent, policy), goal, root, `${parent.taskId}:child`)
const promptOf = (task: TaskContract) =>
  String(
    compileTaskContext({
      task,
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 16_000
    }).message.content
  )

describe('child task requirements', () => {
  const python = () => parentOf('Implement a booking service in Python in this project')

  it('keeps the parent language when the subgoal omits it', () => {
    const child = childOf(python(), 'Implement the booking validator')
    expect(interpretationOf(child).language).toBe('Python')
  })

  it('keeps the parent framework and adds what the child names', () => {
    const parent = parentOf('Build the booking API with FastAPI in Python')
    expect(interpretationOf(parent).frameworks).not.toHaveLength(0)
    const [framework] = interpretationOf(parent).frameworks
    const child = childOf(parent, 'Add the validator')
    expect(interpretationOf(child).frameworks).toContain(framework)
    expect(interpretationOf(childOf(parent, 'Add a React admin page')).frameworks).toEqual(
      expect.arrayContaining([framework, 'React'])
    )
  })

  const CLAUSE = 'while keeping the public API stable'

  it('puts inherited requirements in the prompt the child model sees', () => {
    const prompt = promptOf(
      childOf(parentOf(`Implement booking in Python ${CLAUSE}`), 'Implement the validator')
    )
    expect(prompt).toContain('"language":"Python"')
    expect(prompt).toContain(`"requirements":["${CLAUSE}"]`)
    expect(prompt).toContain('not additional work')
  })

  it('checks inherited requirements in acceptance', () => {
    const child = childOf(parentOf(`Implement booking in Python ${CLAUSE}`), 'Implement it')
    expect(child.acceptanceCriteria).toContain('Use Python, as the parent request requires.')
    expect(child.acceptanceCriteria.join('\n')).toContain(CLAUSE)
  })

  it('still reaches the child when the parser does not recognize a limit', () => {
    const text = 'Implement booking in Python without changing the public API'
    const parent = parentOf(text)
    const child = childOf(parent, 'Implement the validator')
    expect(child.inherited?.requirements).toEqual([])
    expect(promptOf(child)).toContain(text)
  })

  it('keeps the top-level request through a chain, and bounds it', () => {
    const text = `Implement booking in Python ${'x'.repeat(2_000)}`
    const middle = childOf(parentOf(text), 'Implement the validator')
    const leaf = childOf(middle, 'Add its tests')
    expect(leaf.inherited?.parentRequest).toBe(text.slice(0, 600))
  })

  it('keeps a file the parent named, without making it a task', () => {
    const child = childOf(
      parentOf('Fix the rounding in src/booking/price.py in Python'),
      'Add the validator'
    )
    expect(child.inherited?.files).toContain('src/booking/price.py')
    expect(child.acceptanceCriteria.join('\n')).not.toContain('src/booking/price.py')
  })

  it('records a conflicting language and keeps the parent requirement', () => {
    const child = childOf(python(), 'Rewrite the validator in Rust')
    expect(interpretationOf(child).language).toBe('Python')
    expect(child.inherited?.conflicts).toEqual([
      { field: 'language', parent: 'Python', child: 'Rust' }
    ])
    expect(child.acceptanceCriteria.join('\n')).toContain('report the conflict')
    expect(promptOf(child)).toContain('requirementConflicts')
  })

  it('treats a matching language as agreement', () => {
    expect(childOf(python(), 'Add a Python validator').inherited?.conflicts).toEqual([])
  })

  it('lets a child pick one of several languages the parent named', () => {
    const parent = parentOf('Build the client in Python and TypeScript')
    expect(interpretationOf(parent).language).toBe('Python')
    const child = childOf(parent, 'Write the TypeScript client')
    expect(interpretationOf(child).language).toBe('TypeScript')
    expect(child.inherited?.conflicts).toEqual([])
  })

  it('does not call the source language of a conversion a conflict', () => {
    const parent = parentOf('Convert this Python to TypeScript')
    const child = childOf(parent, 'Inventory the Python modules', 'explore', 'read')
    expect(child.inherited?.conflicts).toEqual([])
    expect(interpretationOf(child).language).toBe('TypeScript')
    expect(interpretationOf(child).sourceLanguage).toBe('Python')
  })

  it('carries requirements through a chain of children', () => {
    const middle = childOf(
      parentOf(`Implement booking in Python ${CLAUSE}`),
      'Implement the validator'
    )
    const leaf = childOf(middle, 'Add its tests')
    expect(interpretationOf(leaf).language).toBe('Python')
    expect(leaf.inherited?.requirements).toContain(CLAUSE)
  })

  it('does not carry the parent recommendations as extra work', () => {
    const parent = { ...python(), recommendations: [{ id: 'r1', text: 'Add caching' }] }
    const child = childOf(parent as never, 'Implement the validator')
    expect(child.recommendations).toEqual([])
    expect(promptOf(child)).not.toContain('Add caching')
  })

  it('keeps its own assignment rather than the parent obligations', () => {
    const child = childOf(python(), 'Implement the validator')
    expect(child.originalText).toBe('Implement the validator')
    expect(child.acceptanceCriteria.join('\n')).not.toContain('booking service')
    expect(child.interpretation?.obligations.map((item) => item.text).join('\n')).not.toContain(
      'booking service'
    )
  })

  it('never widens authority', () => {
    const child = childOf(python(), 'Review the validator', 'review', 'read')
    expect(child.authority).toMatchObject({ tools: 'read', edit: false })
    expect(interpretationOf(child).language).toBe('Python')
  })

  it('keeps a read-only parent read-only whatever the child asks for', () => {
    const parent = parentOf('Review booking in Python and do not edit any files', 'review', 'read')
    const child = childOf(parent, 'Fix the validator', 'edit', 'edit')
    expect(child.authority).toMatchObject({ edit: false })
    expect(interpretationOf(child).forbidsMutation).toBe(true)
    expect(interpretationOf(child).constraints?.edit).toBe(true)
  })

  it('leaves a parent with no stated stack alone', () => {
    const child = childOf(parentOf('Improve the booking flow'), 'Add a validator in Go')
    expect(interpretationOf(child).language).toBe('Go')
    expect(child.inherited).toMatchObject({ stack: [], requirements: [], conflicts: [] })
  })

  it('bounds what it carries', () => {
    const clauses = Array.from({ length: 30 }, (_, i) => `without breaking feature${i}`).join(', ')
    const child = childOf(parentOf(`Implement booking ${clauses}`), 'Implement the validator')
    expect(child.inherited!.requirements.length).toBeLessThanOrEqual(8)
  })
})
