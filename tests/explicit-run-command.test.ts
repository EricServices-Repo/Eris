import { describe, expect, it, vi } from 'vitest'

vi.mock('../electron/main/services/builtin-model', () => ({
  isBuiltinRef: (m: string) => m.startsWith('builtin:'),
  isExactBuiltinReady: () => false,
  resolveExactBuiltinRef: () => null
}))
vi.mock('../electron/main/services/chat-runtime', () => ({ streamModelChat: vi.fn() }))

import { classifyIntentTraced } from '../electron/main/services/chat-router'
import { AgentWorkflow, outcomeContractFor } from '../electron/main/services/agent/workflow'
import { explicitRunCommand } from '../src/shared/task-interpretation'
import type { TurnPlan } from '../src/shared/settings-schema'

// #503: plain shell commands ("Run ls -la …") were classified as explore or
// answer, ran with a read-only agent, and the turn finished without a run call.

const runPlan = (mode: TurnPlan['mode'] = 'agent'): TurnPlan => ({
  intent: 'run', agentId: 'composer', agentName: 'Composer', mode,
  toolPolicy: 'full', requiresTools: true,
  models: { chat: 'local:test', tools: 'local:test' }, escalateToFull: false,
  method: 'heuristic', reason: 'test'
} as TurnPlan)

describe('explicitRunCommand', () => {
  it.each([
    ['Run ls -la in the project folder and tell me how many files there are.', 'ls -la'],
    ['Run the command: wc -l hello.html | tee count.txt and tell me the number of lines.', 'wc -l hello.html | tee count.txt'],
    ['Can you run ls -la for me?', 'ls -la'],
    ['Please run grep -n TODO src', 'grep -n TODO src'],
    ['execute ls', 'ls'],
    ['Run find . -name "*.js"', 'find . -name "*.js"'],
    ['Run make test', 'make test']
  ])('extracts the command from %j', (text, command) => {
    expect(explicitRunCommand(text)).toBe(command)
  })

  it.each([
    'How do I run ls?',
    'Run through the code and explain it',
    'Run the app',
    'run a quick review of todo.js',
    'Run the open source tool',
    'Do not run ls',
    'Run rm -rf build'
  ])('does not treat %j as an explicit command', (text) => {
    expect(explicitRunCommand(text)).toBeNull()
  })
})

describe('run intent for plain shell commands', () => {
  it.each([
    'Run ls -la in the project folder and tell me how many files there are.',
    'Run the command: wc -l hello.html | tee count.txt and tell me the number of lines.',
    'Can you run ls -la for me?'
  ])('classifies %j as run', (text) => {
    expect(classifyIntentTraced(text, 'agent').intent).toBe('run')
  })

  it('keeps how-to questions as answers', () => {
    expect(classifyIntentTraced('How do I run ls?', 'agent').intent).not.toBe('run')
  })

  it('keeps "run through the code" as a read task', () => {
    expect(classifyIntentTraced('Run through the code and explain how it works', 'agent').intent).not.toBe('run')
  })
})

describe('run turns must call the run tool', () => {
  const goal = 'Run ls -la in the project folder and tell me how many files there are.'

  it('records the command on the outcome contract', () => {
    expect(outcomeContractFor(runPlan(), goal).requiredCommand).toBe('ls -la')
    expect(outcomeContractFor(runPlan('ask'), goal).requiredCommand).toBeUndefined()
    expect(outcomeContractFor(runPlan(), 'Run the tests').requiredCommand).toBeUndefined()
  })

  it('rejects an answer built from file reads alone', () => {
    const workflow = new AgentWorkflow(runPlan(), goal)
    workflow.noteTool({ ok: true, mutated: false, name: 'list_dir', path: '.' })
    expect(
      workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/requested command was not run.*ls -la/) })
  })

  it('accepts the turn once the command ran', () => {
    const workflow = new AgentWorkflow(runPlan(), goal)
    workflow.noteTool({ ok: true, mutated: false, name: 'run' })
    expect(
      workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false }).ok
    ).toBe(true)
  })

  it('accepts a denied run: the denial is the outcome to report', () => {
    const workflow = new AgentWorkflow(runPlan(), goal)
    workflow.noteTool({ ok: false, mutated: false, name: 'run', detail: 'denied by user' })
    expect(
      workflow.evaluateOutcome({ workspaceMutated: false, codeMutated: false, verifyPassed: false }).ok
    ).toBe(true)
  })
})
