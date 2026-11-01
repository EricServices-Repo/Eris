import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const model = vi.hoisted(() => ({
  replies: [] as string[],
  calls: [] as Array<{ messages: Array<{ role: string; content: string }> }>
}))
vi.mock('../electron/main/services/agent/stream', async (original) => ({
  ...(await original<object>()),
  collectModelText: async (options: { messages: Array<{ role: string; content: string }> }) => {
    model.calls.push(options)
    return model.replies.shift() ?? ''
  }
}))
import { classifyIntentTraced } from '../electron/main/services/chat-router'
import { resolverBypassRule } from '../electron/main/services/task-resolver'
import { createTaskContract } from '../electron/main/services/task-intake'
import { artifactResponseContract } from '../src/shared/task-interpretation'
import { interpretationOf } from '../src/shared/task-contract'
import { finalizeAnswer } from '../electron/main/services/agent/final-answer'
import { getDefaults } from '../electron/main/services/settings'
import { buildChatTurnMessages } from '../electron/main/services/chat-turn'
import type { TurnPlan } from '../src/shared/settings-schema'
let workspace: string
const plan = (): TurnPlan => ({
  intent: 'answer',
  agentId: 'fast',
  agentName: 'Fast',
  mode: 'agent',
  models: { chat: 'builtin:composer-lite', tools: 'builtin:composer-lite' },
  toolPolicy: 'none',
  requiresTools: false,
  escalateToFull: false,
  reason: 'test',
  method: 'heuristic'
})
const goal = 'Write a story about a dog named Hans'
const story =
  'Hans was a small dog with an enormous map. Every morning he followed its winding paths until one led him home to a friend who had been waiting all along.'
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'eris-creative-'))
  model.calls.length = 0
  model.replies.length = 0
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('Auto creative chat contract', () => {
  it.each([
    goal,
    'Generate a story about a dog named Hans',
    'Help me write a short story about Hans',
    'Can you create a poem about rain?',
    'Write a story about an app that learns to sing'
  ])('keeps %s as chat rather than a code change', (text) => {
    expect(classifyIntentTraced(text, 'agent').intent).toBe('answer')
    expect(resolverBypassRule(text, 'answer')).toBe('creative-writing')
    const current = plan()
    const task = createTaskContract({ workspacePath: workspace, text, plan: current })
    expect(task.scope.applicability).toBe('generic')
    expect(task.authority.edit).toBe(false)
    expect(interpretationOf(task).destination).toBe('chat')
  })
  it('keeps a file edit explicit instead of applying the creative-chat shortcut', () => {
    expect(
      classifyIntentTraced('Create a story and save it in stories/hans.md', 'agent').intent
    ).toBe('edit')
    expect(resolverBypassRule('Create a story and save it in stories/hans.md', 'edit')).not.toBe(
      'creative-writing'
    )
  })
  it('provides generic chat guidance without requiring workspace citations or a three-sentence answer', () => {
    const current = plan()
    const task = createTaskContract({ workspacePath: workspace, text: goal, plan: current })
    current.task = task
    const messages = buildChatTurnMessages(
      workspace,
      getDefaults(),
      {
        text: goal,
        mode: 'agent',
        agentId: 'auto',
        agentName: 'Auto',
        attachments: [],
        skillIds: [],
        history: []
      },
      current
    )
    expect(messages[0].content).not.toContain('Reply in one to three sentences')
    expect(artifactResponseContract(interpretationOf(task), task.scope.applicability)).toContain(
      'creative writing'
    )
  })
})

const finalize = (
  answer: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
) => {
  const current = plan()
  return finalizeAnswer(answer, {
    settings: getDefaults(),
    model: 'test',
    temperature: 0.3,
    getSecret: () => null,
    goal,
    task: createTaskContract({ workspacePath: workspace, text: goal, plan: current }),
    messages: [...history, { role: 'user', content: goal }]
  })
}
describe('creative answer completion and recovery', () => {
  it('repairs the reported unexplained refusal once while preserving conversation constraints', async () => {
    model.replies.push(story)
    const result = await finalize("I'm sorry, but I can't assist with that request.", [
      { role: 'user', content: 'Use the same dog from before. His collar is red.' },
      { role: 'assistant', content: 'His name is Hans.' }
    ])
    expect(result).toMatchObject({ text: story, incomplete: false })
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0].messages.some((m) => m.content.includes('collar is red'))).toBe(true)
  })
  it('marks a repeated unexplained refusal incomplete rather than claiming the story was delivered', async () => {
    model.replies.push("I'm sorry, but I can't assist with that request.")
    expect((await finalize("I'm sorry, but I can't assist with that request.")).incomplete).toBe(
      true
    )
    expect(model.calls).toHaveLength(1)
  })
  it('does not retry an explicit safety refusal', async () => {
    const refusal =
      "I can't help with instructions that would harm someone, but I can help write a safe alternative."
    expect(await finalize(refusal)).toMatchObject({ text: refusal })
    expect(model.calls).toHaveLength(0)
  })
  it('leaves an ordinary story untouched', async () => {
    expect(await finalize(story)).toMatchObject({ text: story, incomplete: false })
    expect(model.calls).toHaveLength(0)
  })
})

describe('answer repair preserves conversational context', () => {
  it('keeps the referenced earlier artifact and system constraints when repairing protocol output', async () => {
    model.replies.push(story)
    const result = await finalizeAnswer('{"name":"read_file","path":"story.txt"}', {
      settings: getDefaults(),
      model: 'test',
      temperature: 0.3,
      getSecret: () => null,
      goal: 'Make the ending happier',
      messages: [
        { role: 'system', content: 'Keep the story appropriate for a five-year-old.' },
        { role: 'user', content: 'The dog is Hans and his collar is red.' },
        { role: 'assistant', content: 'Hans was lost on the mountainside.' },
        { role: 'user', content: 'Make the ending happier' }
      ]
    })
    expect(result.text).toBe(story)
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0].messages.map((message) => message.content).join('\n')).toContain(
      'collar is red'
    )
    expect(
      model.calls[0].messages.some(
        (message) => message.role === 'system' && message.content.includes('five-year-old')
      )
    ).toBe(true)
    expect(
      model.calls[0].messages.filter((message) => message.content === 'Make the ending happier')
    ).toHaveLength(1)
  })
})
