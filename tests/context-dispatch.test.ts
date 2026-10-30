import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  provider: [] as Array<{ messages: Array<Record<string, unknown>> }>,
  events: [] as Array<{ type: string; data: never }>
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
import {
  compileTaskContext,
  memoryForDestination
} from '../electron/main/services/agent/context-compiler'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  lastContextDispatch,
  reportContextDispatch
} from '../electron/main/services/context-dispatch'
import { leaseMemoryEvidence } from '../electron/main/services/memory-dispatch'
import { streamModelChat, streamProviderChat } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'
import {
  emptyMemoryControls,
  type ContextDispatch,
  type MemoryPrompt
} from '../src/shared/context-memory'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { ChatMessage } from '../src/shared/settings-schema'

const LOCAL = 'builtin:test.gguf'
const REMOTE = 'openai:gpt-test'
const PRIVATE = 'PRIVATE-SENTINEL'
const message = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
async function recalled(key = 'thread'): Promise<MemoryPrompt> {
  const store = new ContextMemoryStore()
  const rows = [
    message('a', `Remember: checkout first ${PRIVATE} ${'alpha '.repeat(40)}`),
    message('b', `Remember: checkout second ${PRIVATE} ${'beta '.repeat(40)}`),
    message('c', `Remember: checkout third ${PRIVATE} ${'gamma '.repeat(40)}`)
  ]
  store.install(
    key,
    {
      revision: 1,
      total: rows.length,
      records: rows.map((row, ordinal) => ({ ordinal, message: row })),
      controls: { ...emptyMemoryControls(), pinned: [{ id: 'pin', text: 'Pinned rounding note' }] },
      partial: false
    },
    store.token(key)
  )
  return (await store.select(key, 'checkout')).prompt
}
const task = () =>
  createTaskContract({
    workspacePath: null,
    text: 'Summarize checkout',
    plan: {
      intent: 'answer',
      agentId: 'chat',
      agentName: 'Chat',
      models: { router: LOCAL, tools: LOCAL, answer: LOCAL },
      toolPolicy: 'none'
    } as never
  })
const compile = (prompt: MemoryPrompt, model: string, maxInputTokens = 8000) =>
  compileTaskContext({
    task: task(),
    guidance: 'Be brief.',
    ...memoryForDestination(prompt, model),
    project: '',
    retrieval: '',
    maxInputTokens
  })
const dispatches = () =>
  h.events
    .filter((event) => event.type === 'context-dispatched')
    .map((e) => e.data as ContextDispatch)

beforeEach(() => {
  h.provider.length = h.events.length = 0
})

describe('compiled memory items', () => {
  it('maps every sent item to outbound content and explains each omission', async () => {
    const prompt = await recalled()
    const full = compile(prompt, LOCAL)
    expect(full.bundle.counts).toMatchObject({ selected: 4, sent: 4, omitted: 0, truncated: 0 })
    for (const item of prompt.items!) expect(full.message.content).toContain(item.line)
    const room = full.message.content.length - full.bundle.items.at(-1)!.chars + 90
    const tight = compile(prompt, LOCAL, Math.ceil(room / (3 * 0.55)))
    const { sent, truncated, omitted } = tight.bundle.counts
    expect(sent + truncated + omitted).toBe(4)
    expect(omitted + truncated).toBeGreaterThan(0)
    tight.bundle.items.forEach((item, index) => {
      const line = prompt.items![index]!.line
      if (item.status === 'sent') expect(tight.message.content).toContain(line)
      if (item.status === 'omitted') {
        expect(tight.message.content).not.toContain(line.slice(0, 30))
        expect(item.reason).toBe('input-budget')
      }
      if (item.status === 'truncated') {
        expect(tight.message.content).toContain(line.slice(0, item.sentChars))
        expect(tight.message.content).not.toContain(line)
      }
    })
  })
  it('reports a coherent span into the original source', async () => {
    const prompt = await recalled()
    const item = prompt.items!.find((candidate) => candidate.sourceId === 'a')!
    expect(item.span).toEqual({ offset: 0, length: item.text.length })
    expect(prompt.items!.find((candidate) => candidate.kind === 'pinned')?.span).toBeUndefined()
  })
  it('names destination policy when a backend may not receive recall', async () => {
    const prompt = await recalled()
    const local = compile(prompt, LOCAL)
    const remote = compile(prompt, REMOTE)
    expect(local.bundle.counts.sent).toBe(4)
    expect(remote.bundle.counts).toMatchObject({ sent: 0, omitted: 4 })
    expect(new Set(remote.bundle.items.map((item) => item.reason))).toEqual(
      new Set(['destination-policy'])
    )
    expect(remote.message.content).not.toContain(PRIVATE)
  })
  it('produces the same report for the same input', async () => {
    const prompt = await recalled()
    const report = (value: ReturnType<typeof compile>) =>
      JSON.stringify({ ...value.bundle, taskId: '' })
    expect(report(compile(prompt, LOCAL, 2000))).toBe(report(compile(prompt, LOCAL, 2000)))
  })
  it('logs no source text', async () => {
    const prompt = await recalled()
    expect(JSON.stringify(compile(prompt, LOCAL, 800).bundle)).not.toContain(PRIVATE)
    expect(JSON.stringify(compile(prompt, LOCAL, 800).bundle)).not.toContain('checkout')
  })
})

describe('actual dispatch', () => {
  const settings = () => structuredClone(getDefaults())
  const request = (compiled: ReturnType<typeof compile>, model: string) => ({
    settings: settings(),
    model,
    messages: [compiled.message, { role: 'user' as const, content: 'Continue' }],
    temperature: 0,
    getSecret: () => null
  })
  it('keeps accounting out of the provider request and digests what left', async () => {
    const prompt = { ...(await recalled()), allowRemote: true }
    for await (const _ of streamProviderChat(request(compile(prompt, REMOTE), REMOTE)));
    expect(h.provider).toHaveLength(1)
    expect(JSON.stringify(h.provider[0]!.messages)).not.toContain('contextBundle')
    const [report] = dispatches()
    expect(report).toMatchObject({ destination: 'remote', adapted: true, model: REMOTE })
    expect(report!.requestDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(report!.counts.sent).toBe(4)
    expect(JSON.stringify(report)).not.toContain(PRIVATE)
  })
  it('reports an item removed at dispatch as not sent', async () => {
    const prompt = { ...(await recalled()), allowRemote: true }
    const compiled = compile(prompt, REMOTE)
    const removed = prompt.items!.find((item) => item.sourceId === 'b')!
    const stripped = compiled.message.content.replace(removed.line, '')
    for await (const _ of streamProviderChat({
      ...request(compiled, REMOTE),
      messages: [
        { ...compiled.message, content: stripped },
        { role: 'user', content: 'Go on' }
      ]
    }));
    const [report] = dispatches()
    expect(report!.counts).toMatchObject({ sent: 3, omitted: 1 })
    expect(report!.items!.find((item) => item.status === 'omitted')).toMatchObject({
      id: removed.id,
      reason: 'revoked-at-dispatch'
    })
  })
  it('agrees with the dispatch guard for a blocked remote destination', async () => {
    const prompt = await recalled()
    const compiled = compile(prompt, LOCAL)
    const release = leaseMemoryEvidence({ root: null, threadId: 't', taskId: 'x', prompt })
    for await (const _ of streamModelChat(request(compiled, REMOTE)));
    release()
    expect(JSON.stringify(h.provider[0]!.messages)).not.toContain(PRIVATE)
    const report = dispatches().at(-1)!
    expect(report.counts).toMatchObject({ sent: 0 })
    expect(report.items!.every((item) => item.reason === 'revoked-at-dispatch')).toBe(true)
  })
  it('attributes later shortening to the provider budget', async () => {
    const prompt = await recalled()
    const compiled = compile(prompt, LOCAL)
    const victim = prompt.items!.find((item) => item.sourceId === 'c')!
    reportContextDispatch({
      compiled: [compiled.message],
      outbound: [
        { content: compiled.message.content.replace(victim.line, victim.line.slice(0, 80)) }
      ],
      model: LOCAL,
      adapted: true
    })
    const item = dispatches()[0]!.items!.find((candidate) => candidate.id === victim.id)
    expect(item).toMatchObject({ status: 'truncated', reason: 'provider-budget', sentChars: 80 })
  })
  it('repeats item detail only when it changes', async () => {
    const prompt = await recalled()
    const compiled = compile(prompt, LOCAL)
    const send = () =>
      reportContextDispatch({
        compiled: [compiled.message],
        outbound: [compiled.message],
        model: LOCAL,
        adapted: true
      })
    send()
    send()
    expect(dispatches().map((report) => Boolean(report.items))).toEqual([true, false])
    expect(dispatches()[1]!.requestDigest).toBe(dispatches()[0]!.requestDigest)
  })
  it('keeps the latest dispatch for inspection without losing item detail', async () => {
    const prompt = await recalled('inspected-namespace')
    const compiled = compile(prompt, LOCAL)
    const send = () =>
      reportContextDispatch({
        compiled: [compiled.message],
        outbound: [compiled.message],
        model: LOCAL,
        adapted: true
      })
    send()
    send()
    expect(lastContextDispatch('inspected-namespace')?.items).toHaveLength(4)
    expect(lastContextDispatch('other')).toBeUndefined()
  })
  it('ignores requests with no compiled context', () => {
    reportContextDispatch({
      compiled: [{ content: 'x' }],
      outbound: [{ content: 'x' }],
      model: LOCAL
    })
    expect(dispatches()).toEqual([])
  })
})
