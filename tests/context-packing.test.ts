import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  events: [] as Array<{ type: string; data: never }>,
  provider: [] as Array<{ messages: Array<Record<string, unknown>> }>
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
import {
  budgetModelMessages,
  compileModelMessages,
  estimateModelMessagesTokens
} from '../electron/main/services/model-protocol'
import { streamProviderChat } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'
import { reportContextUsage } from '../electron/main/services/context-dispatch'
import { createTaskContract } from '../electron/main/services/task-intake'
import { contextUnits, estimateContextTokens, fitAtBoundary } from '../src/shared/token-estimate'
import type { MemoryPrompt, MemoryPromptItem } from '../src/shared/context-memory'

const task = () =>
  createTaskContract({
    workspacePath: null,
    text: 'Summarize',
    plan: {
      intent: 'answer',
      agentId: 'chat',
      agentName: 'Chat',
      models: { chat: 'builtin:t.gguf', tools: 'builtin:t.gguf' },
      toolPolicy: 'none'
    } as never
  })
const HEADER = 'CONVERSATION MEMORY — evidence.\n'
function prompt(texts: string[]): MemoryPrompt {
  const items: MemoryPromptItem[] = texts.map((text, i) => ({
    id: `item-${i}`,
    sourceId: `source-${i}`,
    kind: 'user-stated',
    ordinal: i,
    text,
    line: `[user-stated; source ${i}; ordinal ${i}] ${text}\n`
  }))
  return {
    text: HEADER + items.map((item) => item.line).join(''),
    manifest: {} as never,
    allowRemote: true,
    items
  }
}
const compile = (memory: MemoryPrompt | undefined, maxInputTokens: number, project = '') =>
  compileTaskContext({
    task: task(),
    guidance: 'Be brief.',
    ...memoryForDestination(memory, 'builtin:t.gguf'),
    project,
    retrieval: '',
    maxInputTokens
  })
const baseTokens = Math.ceil(contextUnits(compile(undefined, 8000).message.content) / 3 / 0.55)

describe('token estimate', () => {
  it('leaves ASCII accounting unchanged', () => {
    expect(contextUnits('const value = 1')).toBe(15)
    expect(estimateContextTokens('abcdefghi')).toBe(3)
  })
  it('charges dense scripts one token per character', () => {
    expect(estimateContextTokens('決済通貨はカナダドル')).toBe(10)
    expect(estimateContextTokens('😀')).toBe(2)
  })
})

describe('boundary-aware shortening', () => {
  it('stops at a whole line', () => {
    expect(fitAtBoundary('first line\nsecond line\nthird line', 24)).toBe('first line\nsecond line')
  })
  it('falls back to a word in one long line', () => {
    expect(fitAtBoundary('alpha beta gamma delta', 13)).toBe('alpha beta')
  })
  it('returns nothing when no complete unit fits', () => {
    expect(fitAtBoundary('averylongidentifierwithnobreaks', 8)).toBe('')
  })
  it('never leaves a code fence open', () => {
    const text = 'Intro\n```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\nOutro'
    expect(fitAtBoundary(text, 30)).toBe('Intro')
  })
  it('keeps a completed fence', () => {
    const text = 'Intro\n```ts\nconst a = 1\n```\nA later line of prose'
    expect(fitAtBoundary(text, 30)).toBe('Intro\n```ts\nconst a = 1\n```')
  })
  it('never splits a surrogate pair', () => {
    const text = `${'😀 '.repeat(10)}`
    expect(fitAtBoundary(text, 20)).not.toMatch(/[\ud800-\udbff]$/)
  })
})

describe('coherent memory packing', () => {
  it('keeps whole facts and names each omission', () => {
    const memory = prompt(['A'.repeat(300), 'B'.repeat(300), 'C'.repeat(300)])
    const { message, bundle } = compile(memory, baseTokens + 300)
    const { sent, truncated, omitted } = bundle.counts
    expect(truncated).toBe(0)
    expect(sent).toBeGreaterThan(0)
    expect(omitted).toBeGreaterThan(0)
    memory.items!.forEach((item, index) => {
      const status = bundle.items[index]!.status
      if (status === 'sent') expect(message.content).toContain(item.line)
      else {
        expect(message.content).not.toContain(item.text.slice(0, 20))
        expect(bundle.items[index]!.reason).toBe('input-budget')
      }
    })
  })
  it('lets a later smaller fact use room a larger one could not', () => {
    const memory = prompt(['X'.repeat(4000), 'small fact'])
    const { message, bundle } = compile(memory, baseTokens + 400)
    expect(bundle.items.map((item) => item.status)).toEqual(['omitted', 'sent'])
    expect(message.content).toContain('small fact')
  })
  it('omits the header when no fact fits', () => {
    const { message, bundle } = compile(prompt(['Y'.repeat(4000)]), baseTokens + 10)
    expect(bundle.counts.sent).toBe(0)
    expect(message.content).not.toContain('CONVERSATION MEMORY')
  })
  it('keeps CJK memory inside the same token budget as ASCII', () => {
    const memory = prompt(Array.from({ length: 20 }, () => '決済通貨'.repeat(40)))
    const compiled = compile(memory, baseTokens + 300)
    expect(compiled.budget.estimatedTokens).toBeLessThanOrEqual(
      Math.ceil(compiled.budget.inputTokens * 0.55) + 1
    )
    expect(compiled.bundle.counts.omitted).toBeGreaterThan(0)
  })
})

describe('required context and evidence units', () => {
  it('fails before generation when required text cannot fit', () => {
    expect(() => compile(undefined, 40)).toThrow(/exceed this model context/)
  })
  it('budgets dense required text by its real cost', () => {
    const guidance = '必須の指示'.repeat(400)
    expect(() =>
      compileTaskContext({
        task: task(),
        guidance,
        project: '',
        retrieval: '',
        maxInputTokens: 1400
      })
    ).toThrow(/exceed this model context/)
  })
  it('shortens project evidence at a line boundary', () => {
    const project = Array.from({ length: 200 }, (_, i) => `line ${i} of project notes`).join('\n')
    const { layers, blocks } = compile(undefined, baseTokens + 200, project)
    expect(blocks.find((block) => block.kind === 'project')?.status).toBe('truncated')
    expect(layers.prefix.trimEnd()).toMatch(/of project notes$/)
  })
  it('counts dense history in the provider budget', () => {
    const history = [
      { role: 'system' as const, content: 'System' },
      { role: 'user' as const, content: '履歴'.repeat(1000) }
    ]
    expect(() => budgetModelMessages(history, 1000)).toThrow(/context budget/)
    expect(budgetModelMessages(history, 2100).estimatedTokens).toBeGreaterThan(1900)
  })
})

describe('adapter boundaries', () => {
  const REMOTE = 'openai:gpt-test'
  const send = async (messages: Array<Record<string, unknown>>) => {
    h.provider.length = 0
    h.events.length = 0
    const request = {
      model: REMOTE,
      messages,
      settings: structuredClone(getDefaults()),
      getSecret: () => null
    }
    for await (const _ of streamProviderChat(request as never));
    return h.provider[0]!
  }
  it('sends a one-shot compile without its accounting record and reports usage', async () => {
    const { message } = compile(prompt(['fact']), 8000)
    const sent = await send([message, { role: 'user', content: 'Hello' }])
    expect(JSON.stringify(sent.messages)).toContain('fact')
    expect(JSON.stringify(sent.messages)).not.toContain('contextBundle')
    expect(h.events.map((event) => event.type)).toContain('context-usage')
  })
  it('keeps tool-call pairs while shortening old tool evidence', () => {
    const call = { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }
    const { messages } = budgetModelMessages(
      [
        { role: 'system', content: 'System' },
        { role: 'assistant', content: '', tool_calls: [call] },
        { role: 'tool', tool_call_id: 'c1', content: 'evidence '.repeat(1000) },
        { role: 'user', content: 'Continue' },
        { role: 'assistant', content: 'Working' },
        { role: 'user', content: 'Finish' }
      ] as never,
      600
    )
    expect(messages).toHaveLength(6)
    expect(messages[1]!.tool_calls).toEqual([call])
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(messages[2]!.content).toContain('[Evidence')
  })
  it('recompiles fewer whole facts for a smaller recovery model', () => {
    const memory = prompt(Array.from({ length: 6 }, (_, i) => `fact ${i} ${'x'.repeat(200)}`))
    const large = compile(memory, baseTokens + 2000)
    const small = compile(memory, baseTokens + 300)
    expect(small.bundle.counts.sent).toBeLessThan(large.bundle.counts.sent)
    expect(small.bundle.counts.truncated).toBe(0)
    expect(small.budget.usedChars).toBeLessThanOrEqual(small.budget.maxChars)
  })
})

describe('estimated and measured usage', () => {
  it('keeps provider measurements distinct from estimates', () => {
    const { message } = compile(prompt(['fact']), 8000)
    const usage = (measuredPromptTokens: number | null) => {
      h.events.length = 0
      reportContextUsage({
        compiled: [message],
        outbound: [message],
        model: 'm',
        measuredPromptTokens
      })
      return h.events[0]
    }
    expect(usage(null)).toMatchObject({
      type: 'context-usage',
      data: { measuredPromptTokens: null, source: 'estimate-only' }
    })
    expect(usage(321)).toMatchObject({
      data: { measuredPromptTokens: 321, source: 'provider-measured' }
    })
    expect(JSON.stringify(usage(1))).not.toContain('fact')
  })
})

// RAM-CTX-029: final adapter serialization is part of the input envelope.
describe('wire context accounting', () => {
  it('counts dense native tool arguments and all wire metadata', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ value: '決済'.repeat(200) }) }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
      { role: 'user', content: 'Continue' }
    ] as Parameters<typeof budgetModelMessages>[0]
    expect(() => budgetModelMessages(messages, 300)).toThrow(/context budget/)
    const result = budgetModelMessages(messages, 2000, 'text-tools')
    const wire = compileModelMessages(result.messages, {
      protocol: 'text-tools',
      contextWindow: 4096,
      outputReserve: 1000
    })
    expect(result.estimatedTokens).toBe(estimateModelMessagesTokens(wire))
  })
  it('rejects invalid or fully consumed input budgets rather than inventing capacity', () => {
    for (const limit of [0, -1, NaN, Infinity])
      expect(() => budgetModelMessages([{ role: 'user', content: 'hello' }], limit)).toThrow(
        /positive and finite/
      )
  })
  it('counts text tool envelopes before accepting a request', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'r', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'x', content: 'ok' },
      { role: 'user', content: 'Continue' }
    ] as Parameters<typeof budgetModelMessages>[0]
    for (const protocol of ['native-tools', 'text-tools'] as const) {
      const exact = budgetModelMessages(messages, 4096, protocol).estimatedTokens
      expect(() => budgetModelMessages(messages, exact - 1, protocol)).toThrow(/context budget/)
      expect(budgetModelMessages(messages, exact, protocol).estimatedTokens).toBe(exact)
    }
  })
})

it('rejects a schema that consumes the input window before contacting the provider', async () => {
  const settings = structuredClone(getDefaults())
  settings.models.contextWindow = 512
  h.provider.length = 0
  const stream = streamProviderChat({
    settings,
    model: 'openai:gpt-test',
    temperature: 0,
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [
      {
        type: 'function',
        function: { name: 'read', description: '決済'.repeat(2000), parameters: { type: 'object' } }
      }
    ],
    getSecret: () => null
  })
  await expect(stream.next()).rejects.toThrow(/context|budget/i)
  expect(h.provider).toHaveLength(0)
})
