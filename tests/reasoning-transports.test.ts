import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamOpenAICompatible } from '../electron/main/services/openai-compatible'
import { thoughtSegmentOptions } from '../electron/main/services/reasoning-split'
import { transitionTaskTimeline } from '../src/shared/task-timeline'
import { ModelConnectionSchema } from '../src/shared/settings-schema'
import { reasoningShown } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'

/** #573: each transport reports reasoning on its own channel. */

afterEach(() => vi.unstubAllGlobals())

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200 })
}

async function openai(frames: unknown[], extra: Record<string, unknown> = {}) {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return sse(frames)
    })
  )
  const reasoning: string[] = []
  let text = ''
  for await (const chunk of streamOpenAICompatible({
    baseUrl: 'http://test.invalid',
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    onReasoning: (part) => reasoning.push(part),
    ...extra
  }))
    text += chunk
  return { text, reasoning: reasoning.join(''), body: bodies[0]! }
}

describe('OpenAI-compatible reasoning', () => {
  it('reads reasoning_content and reasoning deltas without yielding them', async () => {
    const result = await openai([
      { choices: [{ delta: { reasoning_content: 'first ' } }] },
      { choices: [{ delta: { reasoning: 'second' } }] },
      { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] }
    ])
    expect(result.text).toBe('Answer.')
    expect(result.reasoning).toBe('first second')
    expect(result.body.reasoning_effort).toBeUndefined()
  })

  it('rejects a reasoning delta that is not text', async () => {
    await expect(openai([{ choices: [{ delta: { reasoning_content: 5 } }] }])).rejects.toThrow(
      'reasoning delta must be text'
    )
  })

  it('sends reasoning_effort only for a chosen level', async () => {
    expect((await openai([{ choices: [{ finish_reason: 'stop' }] }], { reasoning: 'high' })).body
      .reasoning_effort).toBe('high')
    expect((await openai([{ choices: [{ finish_reason: 'stop' }] }], { reasoning: 'off' })).body
      .reasoning_effort).toBeUndefined()
  })
})

describe('node-llama-cpp thought segments', () => {
  it('forwards thought segments only, with a budget for a chosen level', () => {
    const seen: string[] = []
    const options = thoughtSegmentOptions('low', 8192, (text) => seen.push(text)) as {
      onResponseChunk: (chunk: { type?: string; segmentType?: string; text?: string }) => void
      budgets?: { thoughtTokens: number }
    }
    options.onResponseChunk({ type: 'segment', segmentType: 'thought', text: 'hmm' })
    options.onResponseChunk({ type: undefined, text: 'answer' })
    options.onResponseChunk({ type: 'segment', segmentType: 'comment', text: 'note' })
    expect(seen).toEqual(['hmm'])
    expect(options.budgets).toEqual({ thoughtTokens: 1024 })
    expect(thoughtSegmentOptions('off', 100, undefined)).toEqual({ budgets: { thoughtTokens: 0 } })
    expect(thoughtSegmentOptions('default', 100, undefined)).toEqual({})
  })
})

describe('task timeline', () => {
  it('counts reasoning as the first model output', () => {
    const step = (timeline: ReturnType<typeof transitionTaskTimeline> | undefined, phase: 'prefill' | 'reasoning' | 'generating', at: number) =>
      transitionTaskTimeline('t', timeline, { phase, at, source: 'transport' }, 10_000)
    const timeline = step(step(step(undefined, 'prefill', 100), 'reasoning', 160), 'generating', 900)
    expect(timeline.firstChunkAt).toBe(160)
    expect(timeline.dispatchToFirstChunkMs).toBe(60)
  })
})

describe('reasoning settings', () => {
  it('parses per-connection reasoning with defaults and rejects unknown levels', () => {
    const base = {
      id: 'c',
      name: 'C',
      type: 'openai-compatible',
      provider: 'custom',
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKeyRef: '',
      models: ['m']
    }
    expect(ModelConnectionSchema.parse({ ...base, reasoning: {} }).reasoning).toEqual({
      level: 'default',
      show: true
    })
    expect(() => ModelConnectionSchema.parse({ ...base, reasoning: { level: 'max' } })).toThrow()
  })

  it('hides reasoning for a connection that turned it off', () => {
    const settings = structuredClone(getDefaults())
    const builtin = settings.models.connections.find((connection) => connection.type === 'builtin')
    expect(reasoningShown(settings, 'builtin:composer-lite')).toBe(true)
    if (builtin) builtin.reasoning = { level: 'default', show: false }
    else
      settings.models.connections.push({
        id: 'builtin',
        name: 'Built-in',
        type: 'builtin',
        provider: 'builtin',
        enabled: true,
        baseUrl: '',
        apiKeyRef: '',
        models: [],
        reasoning: { level: 'default', show: false }
      })
    expect(reasoningShown(settings, 'builtin:composer-lite')).toBe(false)
  })
})
