import * as builtin from '../electron/main/services/builtin-model'
import { recordLoadedModel, clearLoadedModel } from '../electron/main/services/model-runtime'
import { modelTokenizer } from '../electron/main/services/agent/token-count'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPromptTokenCounter } from '../electron/main/services/agent/prompt-token-counter'
import { clearTokenCounts } from '../electron/main/services/agent/token-count'
import {
  compileModelMessages,
  modelPromptMessages,
  budgetModelMessages,
  type ModelMessage
} from '../electron/main/services/model-protocol'
import {
  estimateTokens,
  microCompactAgentMessages
} from '../electron/main/services/agent/compaction'
import { estimateContextTokens } from '../src/shared/token-estimate'
import type { OpenAIToolDef } from '../electron/main/services/openai-compatible'
const tools: OpenAIToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  }
]
const exchange = (content: string): ModelMessage[] => [
  { role: 'system', content: 'Keep the current user task.' },
  { role: 'user', content: 'Inspect the project' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }
    ]
  },
  { role: 'tool', tool_call_id: 'c1', content }
]
afterEach(() => {
  clearTokenCounts()
  clearLoadedModel()
  vi.useRealTimers()
})

describe('prompt accounting at compaction and transport', () => {
  it('counts text-tool schemas, result envelopes and JSON escaping before deciding to compact', async () => {
    const messages = exchange('\n'.repeat(5000))
    const counter = await createPromptTokenCounter(
      'hosted',
      messages,
      tools,
      'text-tools',
      undefined,
      null
    )
    expect(estimateTokens(messages)).toBeLessThan(3000)
    expect(counter.count(messages)).toBeGreaterThan(3000)
    const result = microCompactAgentMessages(messages, 2400, undefined, counter.count)
    expect(result.changed).toBe(true)
    expect(counter.count(result.messages)).toBeLessThanOrEqual(3000)
    // Valid call/result pairs still survive adapter serialization.
    expect(() =>
      compileModelMessages(modelPromptMessages(result.messages, tools, 'text-tools'), {
        protocol: 'text-tools',
        contextWindow: 8192,
        outputReserve: 1024
      })
    ).not.toThrow()
  })
  it('charges native-tool schemas once and omits internal context-bundle metadata', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi', contextBundle: { taskId: 'SECRET-INTERNAL-MARKER' } as never }
    ]
    const counter = await createPromptTokenCounter(
      'hosted',
      messages,
      tools,
      'native-tools',
      undefined,
      null
    )
    const plain = modelPromptMessages(messages, tools, 'native-tools')
    expect(counter.count(messages) - counter.countWire(plain)).toBe(
      estimateContextTokens(JSON.stringify(tools))
    )
    expect(JSON.stringify(plain)).not.toContain('SECRET-INTERNAL-MARKER')
  })
  it('admits prose that fits the resident tokenizer rather than rejecting by character density', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'word '.repeat(20000) }]
    const tokenize = vi.fn(async (texts: string[]) => texts.map(() => 2000))
    const counter = await createPromptTokenCounter(
      'local:prose',
      messages,
      [],
      'text-tools',
      undefined,
      { id: 'prose', tokenize }
    )
    expect(estimateTokens(messages)).toBeGreaterThan(8000)
    expect(counter.count(messages)).toBeLessThan(8000)
    expect(
      budgetModelMessages(messages, 8000, 'text-tools', counter.countWire).messages[0]?.content
    ).toBe(messages[0]?.content)
    expect(counter.method).toContain('native-tokenizer')
    const other = await createPromptTokenCounter(
      'local:dense',
      messages,
      [],
      'text-tools',
      undefined,
      { id: 'dense', tokenize: async () => [20000] }
    )
    expect(other.count(messages)).toBeGreaterThan(8000)
  })
  it('falls back conservatively for changed evidence and unavailable tokenization', async () => {
    const messages = exchange('x'.repeat(10000))
    const counter = await createPromptTokenCounter(
      'local:a',
      messages,
      tools,
      'text-tools',
      undefined,
      { id: 'a', tokenize: async (texts) => texts.map(() => 1) }
    )
    const changed = exchange('different '.repeat(10000))
    expect(counter.count(changed)).toBeGreaterThan(counter.count(messages))
    const fallback = await createPromptTokenCounter(
      'local:a',
      messages,
      tools,
      'text-tools',
      undefined,
      { id: 'failed', tokenize: async () => null }
    )
    expect(fallback.method).toBe('serialized-character-estimate')
    expect(fallback.count(messages)).toBeGreaterThan(3000)
  })
  it('bounds a stalled tokenizer and honors cancellation after its await', async () => {
    vi.useFakeTimers()
    const signal = new AbortController()
    const pending = createPromptTokenCounter(
      'local:a',
      [{ role: 'user', content: 'test' }],
      [],
      'text-tools',
      signal.signal,
      { id: 'stall', tokenize: () => new Promise(() => {}) }
    )
    const rejection = expect(pending).rejects.toThrow('cancel count')
    signal.abort(new Error('cancel count'))
    await vi.advanceTimersByTimeAsync(300)
    await rejection
  })
})

it('does not cache counts under a tokenizer whose resident model changed', async () => {
  recordLoadedModel({ ref: 'builtin:composer-lite', contextSize: 8192 })
  vi.spyOn(builtin, 'residentTokenizerId').mockReturnValue('resident-a')
  vi.spyOn(builtin, 'tokenizeWithLoadedModel').mockImplementation(async () => {
    recordLoadedModel({ ref: 'builtin:composer', contextSize: 8192 })
    return [1]
  })
  const tokenizer = modelTokenizer('builtin:composer-lite')!
  expect(tokenizer).not.toBeNull()
  const result = await tokenizer.tokenize(['model-switch-race'], new AbortController().signal)
  expect(result).toBeNull()
})

it('accounts for an in-flight tool batch without accepting it as a dispatchable transcript', async () => {
  const messages = exchange('done')
  const counter = await createPromptTokenCounter(
    'hosted',
    messages,
    tools,
    'native-tools',
    undefined,
    null
  )
  const pending = messages.slice(0, -1)
  expect(counter.count(pending)).toBeGreaterThan(0)
  expect(() =>
    compileModelMessages(pending, {
      protocol: 'native-tools',
      contextWindow: 8192,
      outputReserve: 1024
    })
  ).toThrow('unresolved tool calls')
})
