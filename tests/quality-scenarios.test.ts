import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { productionScenarioAdapter } from '../electron/dev/scenario-adapter'
import { captureQuestion, captureSettings } from '../electron/dev/capture'
import type { PreparedLiveModel } from '../electron/dev/models'
import type { DevResult } from '../src/shared/eris-dev'
import type { ScenarioFamily, ScenarioTurn } from '../src/shared/quality-scenarios'
const signal = () => new AbortController().signal
const turn: ScenarioTurn = {
  id: 't1',
  prompt: 'Explain why two plus two equals four. Do not edit or execute.',
  heldout: 'Explain addition only.',
  obligations: ['Correct explanation'],
  noEdit: true,
  noRun: true
}
const family: ScenarioFamily = {
  id: 'continuity',
  stratum: 'answer',
  fixture: null,
  turns: [turn, turn]
}
const live = (): PreparedLiveModel => {
  const settings = structuredClone(captureSettings(8192))
  settings.models.defaultModel = 'test-selected-model'
  settings.models.connections = [
    {
      id: 'fixture',
      name: 'Test provider',
      type: 'openai-compatible',
      provider: 'custom',
      enabled: true,
      baseUrl: 'http://fixture.invalid/v1',
      apiKeyRef: 'key',
      models: ['test-selected-model']
    }
  ]
  settings.agent.routing.preferCloudComposer = false
  settings.agent.routing.useLlmRouter = false
  settings.agent.routing.profile = 'local'
  return {
    settings,
    model: 'test-selected-model',
    getSecret: () => 'secret-fixture-credential',
    digest: 'settings-fixture'
  }
}
const input = (index = 0) => ({
  turn,
  index,
  history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  priorTask: null,
  maxCalls: 6,
  maxOutputTokens: 768,
  signal: signal()
})
afterEach(() => vi.unstubAllGlobals())
describe('production scenario sessions', () => {
  it('fails closed without enforced transport limits, and labels cold-load coverage unavailable', async () => {
    const prepare = vi.fn(async () => live()),
      capture = vi.fn(captureQuestion)
    for (const boundedOutput of [false, true]) {
      const adapter = productionScenarioAdapter(8192, { capture, prepare, boundedOutput })
      const session = await adapter.start({
        family: boundedOutput ? { ...family, fault: 'cold-load' } : family,
        model: 'test',
        repeat: 0,
        seed: 'one',
        signal: signal()
      })
      try {
        expect(await session.turn(input())).toMatchObject({
          completion: 'not-exercised',
          calls: 0,
          faultEvidence: { injected: false }
        })
      } finally {
        await session.close()
      }
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })
  it('carries actual completed task identity and answer history through the production intake', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        const intent = body.messages.some((m: { content?: string }) =>
          m.content?.includes('Interpret the latest request')
        )
        const content = intent
          ? ' {"intent":"answer","confidence":0.95}'
          : 'Two plus two equals four by adding two pairs.'
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
    )
    const capture = vi.fn(captureQuestion),
      adapter = productionScenarioAdapter(8192, {
        capture,
        prepare: async () => live(),
        boundedOutput: true
      })
    const session = await adapter.start({
      family,
      model: 'test',
      repeat: 0,
      seed: 'one',
      signal: signal()
    })
    try {
      const first = await session.turn(input())
      expect(first.completion).toBe('complete')
      expect(first.answer).toContain('four')
      const next = {
        ...input(1),
        turn: { ...turn, prompt: 'Explain that reasoning again without changing files.' },
        history: [
          { role: 'user' as const, content: turn.prompt },
          { role: 'assistant' as const, content: first.answer }
        ]
      }
      await session.turn(next)
      const firstOptions = capture.mock.calls[0][6],
        secondOptions = capture.mock.calls[1][6]
      expect(secondOptions?.threadId).toBe(firstOptions?.threadId)
      expect(secondOptions?.priorTask?.taskId).toBe(first.task?.taskId)
      expect(secondOptions?.priorTask?.result?.answerDigest).toBeTruthy()
      expect(secondOptions?.question?.history?.[1].content).toBe(first.answer)
    } finally {
      await session.close()
    }
  })
  it('owns one isolated fixture across turns, observes new artifacts and removes it on close', async () => {
    const roots: string[] = []
    const capture = vi.fn(async (_index: number, _question: string, workspace: string | null) => {
      roots.push(workspace!)
      writeFileSync(join(workspace!, 'new.js'), 'export const value=1')
      return {
        response: 'Fixture changed',
        completion: { status: 'completed' },
        requests: [],
        events: [],
        inference: { calls: 1, firstTokenMs: 2 },
        durationMs: 3
      } as unknown as DevResult
    })
    const adapter = productionScenarioAdapter(8192, {
      capture: capture as typeof captureQuestion,
      prepare: async () => live(),
      boundedOutput: true
    })
    const session = await adapter.start({
      family: { ...family, fixture: { 'original.js': 'original' } },
      model: 'test',
      repeat: 0,
      seed: 'one',
      signal: signal()
    })
    const first = await session.turn(input()),
      second = await session.turn(input(1))
    expect(first.files?.['new.js']).toContain('value=1')
    expect(second.files?.['original.js']).toBe('original')
    expect(roots[0]).toBe(roots[1])
    await session.close()
    expect(existsSync(roots[0])).toBe(false)
  })
  it.each(['provider-error', 'cancelled'] as const)(
    'attributes injected %s before an agent provider invocation',
    async (fault) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '{"intent":"answer","confidence":0.95}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
      vi.stubGlobal('fetch', fetch)
      const result = await captureQuestion(0, turn.prompt, null, 8192, 'ask', signal(), {
        live: live(),
        fault,
        maxCalls: 6,
        timeoutMs: 1000
      })
      expect(result.termination?.cause).toBe(
        fault === 'cancelled' ? 'user-cancelled' : 'provider-error'
      )
      expect(result.events.some((e) => e.startsWith(`Injected ${fault}`))).toBe(true)
      expect(result.completion?.status).not.toBe('completed')
      // If an intent resolver consulted the mocked provider, it is separate from the injected agent request.
      expect(result.requests.find((r) => r.purpose === 'agent')?.error).toContain(
        'before provider invocation'
      )
    }
  )
})
