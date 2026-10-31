import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  provider: [] as Array<{ messages: Array<Record<string, unknown>> }>,
  events: [] as Array<{ type: string; data: never }>,
  settings: { agent: { contextMemory: { shareWithRemoteModels: false } } }
}))
vi.mock('../electron/main/services/openai-compatible', async (original) => ({
  ...(await original<typeof import('../electron/main/services/openai-compatible')>()),
  streamOpenAICompatible: async function* (request: (typeof h.provider)[number]) {
    h.provider.push(request)
    yield 'ok'
  }
}))
vi.mock('../electron/main/services/model-catalog', async (original) => ({
  ...(await original<typeof import('../electron/main/services/model-catalog')>()),
  resolveConnectionForModel: () => ({
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1',
    name: 'test'
  })
}))
vi.mock('../electron/main/services/task-ledger', () => ({
  appendTaskEvent: (_task: string, type: string, data: never) => h.events.push({ type, data })
}))
vi.mock('../electron/main/services/settings', async (original) => ({
  ...(await original<typeof import('../electron/main/services/settings')>()),
  getResolvedSettings: () => h.settings
}))
vi.mock('../electron/main/services/builtin-model', async (original) => ({
  ...(await original<typeof import('../electron/main/services/builtin-model')>()),
  resolveExactBuiltinRef: (model: string) => model,
  streamBuiltinChat: async function* (request: (typeof h.provider)[number]) {
    h.provider.push(request)
    yield 'ok'
  }
}))
import {
  compileTaskContext,
  memoryForDestination
} from '../electron/main/services/agent/context-compiler'
import { compactAgentMessages } from '../electron/main/services/agent/compaction'
import { memoryKey } from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  DERIVED_WITHHELD_NOTICE,
  leaseMemoryEvidence
} from '../electron/main/services/memory-dispatch'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'

const LOCAL = 'builtin:test.gguf'
const REMOTE = 'openai:gpt-test'
const SENTINEL = 'PRIVATE-SENTINEL'
const GOAL = 'Fix the checkout rounding'
const THREAD = 'lineage'
let release: () => void
const row = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
const task = () =>
  createTaskContract({
    // Recovery recompiles the same task; child task changes have a separate guard.
    taskId: 'lineage-task',
    workspacePath: null,
    text: GOAL,
    plan: {
      intent: 'answer',
      agentId: 'chat',
      agentName: 'Chat',
      models: { chat: LOCAL, tools: LOCAL },
      toolPolicy: 'none'
    } as never
  })
async function recalled(allowRemote = false) {
  const key = memoryKey(null, THREAD)
  contextMemoryStore.install(
    key,
    {
      revision: 1,
      total: 1,
      records: [{ ordinal: 0, message: row('a', `Remember: checkout uses ${SENTINEL}`) }],
      controls: emptyMemoryControls(),
      partial: false
    },
    contextMemoryStore.token(key)
  )
  const prompt = { ...(await contextMemoryStore.select(key, 'checkout')).prompt, allowRemote }
  release = leaseMemoryEvidence({ root: null, threadId: THREAD, taskId: 't', prompt })
  return prompt
}
const compiled = (prompt: Awaited<ReturnType<typeof recalled>>, model: string) =>
  compileTaskContext({
    task: task(),
    guidance: 'Be brief.',
    ...memoryForDestination(prompt, model),
    project: '',
    retrieval: '',
    maxInputTokens: 8000
  }).message
const send = async (model: string, messages: Array<Record<string, unknown>>) => {
  h.provider.length = 0
  const request = {
    settings: structuredClone(getDefaults()),
    model,
    messages,
    temperature: 0,
    getSecret: () => null
  }
  for await (const _ of streamModelChat(request as never));
  return JSON.stringify(h.provider[0]?.messages ?? [])
}
/** A local worker reads the memory, then echoes it into every kind of retained state. */
async function localRun() {
  const prompt = await recalled()
  const system = compiled(prompt, LOCAL)
  const goal = { role: 'user', content: GOAL }
  await send(LOCAL, [system, goal])
  return { prompt, system, goal }
}
const echoes = [
  { role: 'assistant', content: `I recall ${SENTINEL}` },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }]
  },
  { role: 'tool', tool_call_id: 'c1', content: `found ${SENTINEL}` },
  { role: 'system', content: `[Eris recovery] Existing work: ${SENTINEL}` }
]

beforeEach(() => {
  h.provider.length = 0
  h.events.length = 0
  h.settings.agent.contextMemory.shareWithRemoteModels = false
})
afterEach(() => release?.())

describe('RAM-CTX-016 derived state', () => {
  it('keeps every role of derived text from a remote reroute', async () => {
    const { prompt, system, goal } = await localRun()
    const wire = await send(REMOTE, [compiled(prompt, REMOTE), system, goal, ...echoes])
    expect(wire).not.toContain(SENTINEL)
    expect(wire).toContain(GOAL)
    expect(wire).toContain(DERIVED_WITHHELD_NOTICE)
    expect(wire).not.toContain('tool_calls')
    expect(h.events.map((event) => event.type)).toContain('derived-context-withheld')
  })
  it('keeps a compacted summary from a remote destination', async () => {
    const { system, goal } = await localRun()
    const { messages } = await compactAgentMessages({
      messages: [system, goal, ...echoes, ...echoes, ...echoes],
      goal: GOAL,
      filesTouched: [],
      actionLog: [`read ${SENTINEL}`],
      treeSnapshot: null,
      priorMemory: `Memory ${SENTINEL}`,
      settings: structuredClone(getDefaults()),
      liteModel: REMOTE,
      temperature: 0,
      getSecret: () => null,
      skipLiteSummary: true
    } as never)
    const wire = await send(REMOTE, messages as never)
    expect(wire).not.toContain(SENTINEL)
    expect(wire).toContain(GOAL)
  })
  it('restores the user request when every user message was generated', async () => {
    await localRun()
    const wire = await send(REMOTE, [{ role: 'user', content: `Summary ${SENTINEL}` }])
    expect(wire).not.toContain(SENTINEL)
    expect(wire).toContain(GOAL)
  })
  it('covers specialist and final review requests in the same run', async () => {
    await localRun()
    const wire = await send(REMOTE, [
      { role: 'system', content: 'Review the result.' },
      { role: 'user', content: `Parent findings: ${SENTINEL}` }
    ])
    expect(wire).not.toContain(SENTINEL)
  })
  it('counts an item the compiler shortened as exposed', async () => {
    const prompt = await recalled()
    const line = prompt.items![0]!.line
    const goal = { role: 'user', content: GOAL }
    await send(LOCAL, [{ role: 'system', content: line.slice(0, line.length - 12) }, goal])
    expect(await send(REMOTE, [goal, ...echoes])).not.toContain(SENTINEL)
  })
  it('applies when remote sharing is turned off after exposure', async () => {
    h.settings.agent.contextMemory.shareWithRemoteModels = true
    const prompt = await recalled(true)
    const goal = { role: 'user', content: GOAL }
    await send(LOCAL, [compiled(prompt, LOCAL), goal])
    h.settings.agent.contextMemory.shareWithRemoteModels = false
    expect(await send(REMOTE, [goal, ...echoes])).not.toContain(SENTINEL)
  })
})

describe('permitted context', () => {
  it('still gives the local model its own derived state', async () => {
    const { system, goal } = await localRun()
    expect(await send(LOCAL, [system, goal, ...echoes])).toContain(`found ${SENTINEL}`)
  })
  it('leaves remote requests alone when sharing was allowed', async () => {
    h.settings.agent.contextMemory.shareWithRemoteModels = true
    const prompt = await recalled(true)
    const goal = { role: 'user', content: GOAL }
    await send(LOCAL, [compiled(prompt, LOCAL), goal])
    expect(await send(REMOTE, [goal, ...echoes])).toContain(`found ${SENTINEL}`)
  })
  it('does nothing until a model has received an item', async () => {
    await recalled()
    const goal = { role: 'user', content: GOAL }
    const later = { role: 'assistant', content: 'Unrelated progress' }
    const wire = await send(REMOTE, [goal, later])
    expect(wire).toContain('Unrelated progress')
    expect(wire).not.toContain(DERIVED_WITHHELD_NOTICE)
  })
  it('stops withholding when the run ends', async () => {
    const { goal } = await localRun()
    release()
    const later = { role: 'assistant', content: 'Next run' }
    expect(await send(REMOTE, [goal, later])).toContain('Next run')
  })
})
