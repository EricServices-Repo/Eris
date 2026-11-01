import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaults } from '../electron/main/services/settings'
import { createTaskContract } from '../electron/main/services/task-intake'
import {
  SYSTEM_CONTEXT_SHARE,
  compileTaskContext,
  contextCompilationFor
} from '../electron/main/services/agent/context-compiler'
import { compileMeasuredContext } from '../electron/main/services/agent/measured-context'
import {
  TOKEN_COUNT_DEADLINE_MS,
  cachedTokenCount,
  clearTokenCounts,
  primeTokenCounts,
  type ModelTokenizer
} from '../electron/main/services/agent/token-count'
import { resolveModelCapabilities } from '../electron/main/services/model-capabilities'

/**
 * Shaped on `model.tokenize()` for Qwen2.5-Coder and Qwen3.5: prose about 5 characters a
 * token, hex about 1.1, punctuation one each, CJK about 0.6 tokens a character.
 */
function realisticTokens(text: string) {
  let tokens = 0
  for (const run of text.match(/[a-f0-9]{8,}|[A-Za-z]+|\s+|[^\x00-\x7f]|./gs) ?? []) {
    if (/^[a-f0-9]{8,}$/.test(run)) tokens += run.length / 1.13
    else if (/^[A-Za-z]/.test(run)) tokens += Math.max(1, run.length / 5)
    else if (/^\s/.test(run)) tokens += 0
    else if (/[^\x00-\x7f]/.test(run)) tokens += 0.65
    else tokens += 1
  }
  return Math.ceil(tokens)
}
const tokenizer = (id = 'test:1'): ModelTokenizer & { tokenize: ReturnType<typeof vi.fn> } => ({
  id,
  tokenize: vi.fn(async (texts: string[]) => texts.map(realisticTokens))
})

const plan = {
  intent: 'answer',
  agentId: 'chat',
  agentName: 'Chat',
  models: { chat: 'local:test', tools: 'local:test' },
  toolPolicy: 'none'
} as unknown as Parameters<typeof createTaskContract>[0]['plan']
const task = createTaskContract({ workspacePath: null, text: 'Explain this', plan })
const input = (project: string, maxInputTokens = 8_000) => ({
  task,
  guidance: 'Answer clearly.',
  project,
  retrieval: '',
  maxInputTokens
})
const limit = (tokens = 8_000) => Math.floor(tokens * SYSTEM_CONTEXT_SHARE)

const repeat = (text: string, chars: number) => text.repeat(Math.ceil(chars / text.length))
const hex = Array.from({ length: 12_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(16))
const DENSE = {
  prose: repeat('The context compiler keeps whole lines when it can.\n', 90_000),
  code: repeat('export const value = compute(items.map((item) => item.id))\n', 90_000),
  minifiedJson: repeat(
    `${'{"a":[1,2,3],"b":{"c":null,"d":"x"},"e":[true,false]},'.repeat(40)}\n`,
    90_000
  ),
  cjk: repeat('上下文压缩不会丢失信息，模型只需要在需要时读取证据。\n', 50_000),
  hex: hex.join('\n'),
  longIdentifiers: repeat(`${'deeplyNestedConfigurationResolver'.repeat(8)}_${hex[9]}\n`, 90_000),
  unicode: repeat('naïve café — 🙂🚀 Ωμέγα кириллица\n', 50_000)
}

beforeEach(clearTokenCounts)

describe('primeTokenCounts', () => {
  const noWait = async (texts: string[]) => texts.map(realisticTokens)

  it('counts each text once per tokenizer', async () => {
    const tokenize = vi.fn(noWait)
    await primeTokenCounts('a', ['one', 'two', 'one'], tokenize)
    await primeTokenCounts('a', ['one', 'two'], tokenize)
    expect(tokenize).toHaveBeenCalledTimes(1)
    expect(tokenize.mock.calls[0]![0]).toEqual(['one', 'two'])
  })

  it('never shares a count between tokenizers', async () => {
    await primeTokenCounts('a', ['same text'], async () => [7])
    expect(cachedTokenCount('a')('same text')).toBe(7)
    expect(cachedTokenCount('b')('same text')).toBeUndefined()
  })

  it('splits a large prompt across batches', async () => {
    const tokenize = vi.fn(noWait)
    await primeTokenCounts('a', ['x'.repeat(50_000), 'y'.repeat(50_000)], tokenize)
    expect(tokenize).toHaveBeenCalledTimes(2)
  })

  it('reports a failed or mismatched tokenizer', async () => {
    expect(await primeTokenCounts('a', ['x'], async () => null)).toBe(false)
    expect(await primeTokenCounts('a', ['x'], async () => [])).toBe(false)
    expect(
      await primeTokenCounts('a', ['x'], async () => {
        throw new Error('gone')
      })
    ).toBe(false)
  })

  it('gives up at the deadline and does not cache anything', async () => {
    const hung = () => new Promise<number[]>(() => undefined)
    const start = Date.now()
    expect(await primeTokenCounts('a', ['x'], hung, 20)).toBe(false)
    expect(Date.now() - start).toBeLessThan(TOKEN_COUNT_DEADLINE_MS)
    expect(cachedTokenCount('a')('x')).toBeUndefined()
  })

  it('tells the tokenizer to stop once it has its answer or none', async () => {
    let signal: AbortSignal | undefined
    await primeTokenCounts('a', ['x'], async (texts, next) => {
      signal = next
      return texts.map(() => 1)
    })
    expect(signal?.aborted).toBe(true)
  })
})

describe('compileMeasuredContext', () => {
  for (const [name, text] of Object.entries(DENSE)) {
    it(`packs ${name} to the real count, inside the limit`, async () => {
      const { bundle, budget, message } = await compileMeasuredContext(
        input(text),
        'local:test',
        tokenizer()
      )
      const exact = realisticTokens(String(message.content))
      expect(exact).toBeLessThanOrEqual(limit())
      expect(exact).toBeGreaterThan(limit() * 0.8)
      expect(bundle.tokenizer).toEqual({
        method: 'native-tokenizer',
        tokenizer: 'test:1',
        exactTokens: exact
      })
      expect(budget).toMatchObject({ method: 'native-tokenizer', measuredTokens: exact })
    })
  }

  it('fixes both failures of the estimate', () => {
    const overrun = compileTaskContext(input(DENSE.hex))
    expect(realisticTokens(String(overrun.message.content))).toBeGreaterThan(limit() * 2)
    const wasted = compileTaskContext(input(DENSE.prose))
    expect(realisticTokens(String(wasted.message.content))).toBeLessThan(limit() * 0.7)
  })

  it('drops one oversized unbroken line rather than cutting inside it, as the estimate does', async () => {
    const line = '{"a":[1,2,3]},'.repeat(4_000)
    const { message, blocks } = await compileMeasuredContext(input(line), 'local:test', tokenizer())
    expect(String(message.content)).not.toContain('{"a":[1,2,3]}')
    expect(String(compileTaskContext(input(line)).message.content)).not.toContain('{"a":[1,2,3]}')
  })

  it('packs again when a cut is denser than its block', async () => {
    // Dense at the front, so the part that fits costs far more than the block average.
    const denseFirst = `${DENSE.hex.slice(0, 7_000)}\n${DENSE.prose}`
    const first = compileTaskContext({
      ...input(denseFirst),
      tokenCount: (text) => realisticTokens(text)
    })
    expect(realisticTokens(String(first.message.content))).toBeGreaterThan(limit())
    const { message, bundle } = await compileMeasuredContext(
      input(denseFirst),
      'local:test',
      tokenizer()
    )
    expect(realisticTokens(String(message.content))).toBeLessThanOrEqual(limit())
    expect(bundle.tokenizer).toMatchObject({ method: 'native-tokenizer' })
  })

  it('stops a required block that only looks small enough', async () => {
    const guidance = hex.slice(0, 400).join('')
    const oversized = { ...input('none', 3_000), guidance }
    expect(() => compileTaskContext(oversized)).not.toThrow()
    await expect(compileMeasuredContext(oversized, 'local:test', tokenizer())).rejects.toThrow(
      'exceed this model context'
    )
  })

  it('prices recalled items by their real count', async () => {
    const dense = `${hex.slice(0, 700).join('')}\n`
    const item = (id: string, line: string, ordinal: number) => ({
      id,
      sourceId: `s-${id}`,
      kind: 'prior-answer' as const,
      ordinal,
      text: line,
      line
    })
    const items = [item('dense', dense, 1), item('plain', 'a short plain note\n', 2)]
    const { bundle } = await compileMeasuredContext(
      {
        ...input('', 2_000),
        memory: `MEMORY\n${dense}a short plain note\n`,
        memoryItems: items
      },
      'local:test',
      tokenizer()
    )
    const status = Object.fromEntries(bundle.items.map((entry) => [entry.id, entry.status]))
    expect(status).toEqual({ dense: 'omitted', plain: 'sent' })
  })

  it('does not tokenize again for an unchanged prompt', async () => {
    const counter = tokenizer()
    await compileMeasuredContext(input(DENSE.prose), 'local:test', counter)
    const calls = counter.tokenize.mock.calls.length
    await compileMeasuredContext(input(DENSE.prose), 'local:test', counter)
    expect(counter.tokenize.mock.calls.length).toBe(calls)
  })

  it('keeps the counts on the snapshot, so a preview packs the same way', async () => {
    const { bundle } = await compileMeasuredContext(input('x'), 'local:test', tokenizer())
    expect(contextCompilationFor(bundle)?.tokenCount).toBeTypeOf('function')
  })

  it.each([
    ['connection:remote', 'no-local-tokenizer'],
    ['local:test', 'model-not-loaded']
  ])('records why %s used the estimate', async (model, fallback) => {
    const estimate = compileTaskContext(input('words'))
    const { bundle, budget, message } = await compileMeasuredContext(input('words'), model, null)
    expect(bundle.tokenizer).toMatchObject({ method: 'characters', tokenizer: 'none', fallback })
    expect(budget).toMatchObject({ method: 'characters', fallback })
    expect(message.content).toBe(estimate.message.content)
  })

  it('falls back when the tokenizer fails mid-send, without failing the send', async () => {
    const failing = { id: 't', tokenize: async () => null }
    const { bundle } = await compileMeasuredContext(input('words'), 'local:test', failing)
    expect(bundle.tokenizer).toMatchObject({
      method: 'characters',
      fallback: 'tokenizer-unavailable'
    })
  })
})

describe('tokenCounting', () => {
  it('does not claim a tokenizer for a model that is not loaded', () => {
    const settings = getDefaults()
    expect(resolveModelCapabilities(settings, 'connection:remote').tokenCounting).toBe(
      'character-estimate'
    )
    expect(resolveModelCapabilities(settings, 'builtin:unloaded').tokenCounting).toBe(
      'character-estimate'
    )
  })
})
