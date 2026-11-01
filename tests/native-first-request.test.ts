import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/shared/settings-schema'

const G = 1024 ** 3
const h = vi.hoisted(() => ({
  allocate: 2048 as number | null,
  sent: [] as Array<Array<{ role: string; content: string }>>,
  generated: 0,
  events: [] as Array<{ type: string; data: Record<string, unknown> }>
}))
const local = {
  id: 'big',
  ref: 'local:big',
  contextWindow: 131072,
  approxBytes: 9 * G,
  role: 'local',
  tier: 'full'
}
vi.mock('../electron/main/services/local-model', () => ({
  isLocalRef: (ref: string) => ref.startsWith('local:'),
  findLocalEntry: () => local,
  localEntryAsBuiltin: (entry: unknown) => entry,
  resolveExactLocalRef: (ref: string) => ref
}))
vi.mock('../electron/main/services/tool-protocol', () => ({ toolProtocolFor: () => 'text-tools' }))
vi.mock('../electron/main/services/gpu-accel', async (original) => ({
  ...(await original<object>()),
  lastGpuAccelStatus: () => ({ vramBudgetBytes: 12 * G })
}))
vi.mock('../electron/main/services/task-ledger', async (original) => ({
  ...(await original<object>()),
  appendTaskEvent: (_task: string, type: string, data: Record<string, unknown>) =>
    h.events.push({ type, data })
}))
// A scripted native loader: the plan is 8,192 and the load lands wherever the test says.
vi.mock('../electron/main/services/builtin-model', async (original) => {
  const actual = await original<typeof import('../electron/main/services/builtin-model')>()
  const { recordLoadedModel } = await import('../electron/main/services/model-runtime')
  return {
    ...actual,
    streamBuiltinChat: async function* (request: {
      modelRef: string
      messages: Array<{ role: string; content: string }>
      prepareMessages?: () => Promise<Array<{ role: string; content: string }>>
      onTermination?: (termination: { reason: string }) => void
    }) {
      if (h.allocate) recordLoadedModel({ ref: request.modelRef, contextSize: h.allocate })
      const messages = request.prepareMessages ? await request.prepareMessages() : request.messages
      h.sent.push(messages)
      h.generated++
      yield 'ok'
      request.onTermination?.({ reason: 'eos' })
    }
  }
})

import { streamProviderChat } from '../electron/main/services/chat-runtime'
import { resolveModelCapabilities } from '../electron/main/services/model-capabilities'
import {
  clearLoadedModel,
  loadedModelFacts,
  recordLoadedModel,
  updateLoadedAllocation
} from '../electron/main/services/model-runtime'
import { estimateModelMessagesTokens } from '../electron/main/services/model-protocol'
import { promptFitProblem, replyTokenAllowance } from '../src/shared/llama-session'

const settings = {
  models: { connections: [], contextWindow: 32768 },
  agent: { contextMemory: {} }
} as unknown as AppSettings

/** Far over 2,048 tokens, well inside the 8,192 plan's 65%, and mostly shortenable evidence. */
const evidence = (size: number) =>
  Array.from({ length: 3 }, (_, index) => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `c${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: `c${index}`, content: `${index}`.repeat(size) }
  ]).flat()

const contextBundle = { taskId: 't', items: [], counts: {} }
const send = async (messages: unknown[], extra: object = {}) => {
  for await (const _ of streamProviderChat({
    settings,
    model: 'local:big',
    messages: messages as never,
    temperature: 0,
    getSecret: () => null,
    ...extra
  }));
}

beforeEach(() => {
  h.allocate = 2048
  h.sent.length = h.events.length = h.generated = 0
  clearLoadedModel()
})
afterEach(() => clearLoadedModel())

describe('the first native request after a smaller allocation', () => {
  it('starts from the 8,192-token plan', () => {
    expect(resolveModelCapabilities(settings, 'local:big')).toMatchObject({
      contextCeiling: 8192,
      contextSource: 'runtime-plan'
    })
  })

  it('re-budgets to the measured window, leaving room for the reply', async () => {
    const messages = [
      { role: 'system', content: 'Instructions', contextBundle },
      { role: 'user', content: 'Goal' },
      ...evidence(3000),
      { role: 'user', content: 'Continue' }
    ]
    // The fixture must really overflow the measured window, or this proves nothing.
    expect(estimateModelMessagesTokens(messages as never)).toBeGreaterThan(2048)
    await send(messages)
    const window = resolveModelCapabilities(settings, 'local:big')
    expect(window).toMatchObject({ contextCeiling: 2048, contextSource: 'measured-allocation' })
    const sent = estimateModelMessagesTokens(h.sent[0] as never)
    expect(sent).toBeLessThanOrEqual(window.promptBudget)
    expect(sent + window.outputReserve).toBeLessThanOrEqual(2048)
    expect(JSON.stringify(h.sent[0])).toContain('Instructions')
    expect(JSON.stringify(h.sent[0])).toContain('Goal')
  })

  it('refuses before generation when required instructions cannot fit, naming both sizes', async () => {
    const messages = [
      { role: 'system', content: 'R'.repeat(6000) },
      { role: 'user', content: 'Goal' }
    ]
    await expect(send(messages)).rejects.toThrow(/2,048-token context instead of the planned 8,192/)
    expect(h.generated).toBe(0)
  })

  it('does not truncate a required system block to make it fit', async () => {
    const required = `KEEP-START ${'R'.repeat(1500)} KEEP-END`
    await send([
      { role: 'system', content: required },
      { role: 'user', content: 'Goal' }
    ])
    expect(JSON.stringify(h.sent[0])).toContain('KEEP-END')
  })

  it('keeps the plain budget error when the window is what was planned', async () => {
    h.allocate = 8192
    await expect(
      send([
        { role: 'system', content: 'R'.repeat(40000) },
        { role: 'user', content: 'Goal' }
      ])
    ).rejects.toThrow(/exceed model context/)
  })

  it('tells a plan from a measurement in the dispatch record', async () => {
    await send([
      { role: 'system', content: 'Instructions', contextBundle },
      { role: 'user', content: 'Goal' }
    ])
    const dispatches = h.events.filter((event) => event.type === 'context-dispatched')
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.data.context).toEqual({
      source: 'measured-allocation',
      tokens: 2048,
      plannedTokens: 8192
    })
  })

  it('omits the plan when the load matched it', async () => {
    h.allocate = 8192
    await send([
      { role: 'system', content: 'Instructions', contextBundle },
      { role: 'user', content: 'Goal' }
    ])
    expect(h.events.find((event) => event.type === 'context-dispatched')!.data.context).toEqual({
      source: 'measured-allocation',
      tokens: 8192
    })
  })

  it('keeps the caller’s output limit after re-reading capacity', async () => {
    let reported: number | undefined
    await send(
      [
        { role: 'system', content: 'Instructions' },
        { role: 'user', content: 'Goal' }
      ],
      {
        maxOutputTokens: 77,
        onTermination: (termination: { capabilities?: { outputCap: number } }) => {
          reported = termination.capabilities?.outputCap
        }
      }
    )
    expect(reported).toBe(77)
  })
})

describe('context recreation', () => {
  it('re-reads capacity when the worker rebuilds the context smaller', async () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 8192, gpuLayers: 40, device: 'Metal' })
    updateLoadedAllocation({ contextSize: 1024 })
    expect(resolveModelCapabilities(settings, 'local:big')).toMatchObject({
      contextCeiling: 1024,
      contextSource: 'measured-allocation'
    })
    expect(loadedModelFacts('local:big')).toMatchObject({ gpuLayers: 40, device: 'Metal' })
  })

  it('falls back to the plan rather than trust a rebuild that reports no size', () => {
    recordLoadedModel({ ref: 'local:big', contextSize: 2048 })
    updateLoadedAllocation({})
    expect(resolveModelCapabilities(settings, 'local:big').contextSource).toBe('runtime-plan')
  })

  it('ignores a late report once nothing is resident', () => {
    updateLoadedAllocation({ contextSize: 1024 })
    expect(loadedModelFacts('local:big')).toBeNull()
  })

  it('applies the same rule after a worker restart or model switch', async () => {
    const messages = [
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: 'Goal' },
      ...evidence(3000),
      { role: 'user', content: 'Continue' }
    ]
    await send(messages)
    clearLoadedModel() // What a worker exit or model switch does.
    h.allocate = 3072
    await send(messages)
    const window = resolveModelCapabilities(settings, 'local:big')
    expect(window.contextCeiling).toBe(3072)
    expect(estimateModelMessagesTokens(h.sent[1] as never)).toBeLessThanOrEqual(window.promptBudget)
  })
})

describe('the worker’s last check', () => {
  it('rejects what would need a context shift, and allows what fits', () => {
    expect(promptFitProblem({ contextSize: 2048, promptTokens: 1800 })).toBeNull()
    expect(promptFitProblem({ contextSize: 2048, promptTokens: 1900 })).toMatch(
      /exceeds the 2,048-token context/
    )
  })

  it('does not let the reply floor hide an overflow', () => {
    // The allowance alone reports 256 here; only the check above stops the request.
    expect(replyTokenAllowance({ requested: 1024, contextSize: 2048, promptTokens: 4000 })).toBe(
      256
    )
  })
})
