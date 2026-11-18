import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamProviderChat } from '../electron/main/services/chat-runtime'
import { contextProvenance, resolveModelCapabilities } from '../electron/main/services/model-capabilities'
import { resolveRoutingCapabilityProfile } from '../electron/main/services/model-capability-ranking'
import { clearOllamaRuntimeFacts, prepareModelWindows } from '../electron/main/services/ollama-runtime'
import { recordProviderContexts } from '../electron/main/services/provider-context'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'

vi.mock('../electron/main/services/usage-stats', async (original) => ({
  ...(await original<typeof import('../electron/main/services/usage-stats')>()),
  recordModelUsage: () => undefined
}))

const endpoint = 'https://provider-context.test/v1'
const profile = {
  enabled: true, contextWindowMode: 'model-maximum' as const, contextWindow: 4096,
  tier: 'standard' as const, toolCalling: 'text' as const,
  reasoning: false, vision: false, costClass: 'low' as const
}
function settingsFor(cloud: boolean) {
  const connection: ModelConnection = {
    id: cloud ? 'eris-cloud' : 'hosted', name: 'Hosted', type: 'openai-compatible',
    provider: cloud ? 'ollama' : 'custom', enabled: true, baseUrl: endpoint,
    apiKeyRef: 'fixture-key', models: ['m'], modelLimits: { m: { contextWindow: 8192 } }
  }
  const model = cloud ? 'cloud:m' : 'm'
  const settings = { models: {
    connections: [connection], contextWindow: 32768, capabilityProfiles: { [model]: { ...profile } }
  }, agent: { contextMemory: {} } } as unknown as AppSettings
  return { settings, connection, model }
}

type Seen = { path: string; body?: Record<string, unknown>; authorization: string | null }
function provider(options: { rows?: unknown[]; showWindow?: number; chatError?: number } = {}) {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    seen.push({ path, body, authorization: new Headers(init?.headers).get('Authorization') })
    if (path === '/v1/models')
      return Response.json({ data: options.rows ?? [{ id: 'm', context_length: 262144, max_output_tokens: 8192 }] })
    if (path === '/api/show')
      return options.showWindow
        ? Response.json({ model_info: { 'general.architecture': 'llama', 'llama.context_length': options.showWindow } })
        : new Response(null, { status: 404 })
    if (path === '/api/chat' || path === '/v1/chat/completions') {
      if (options.chatError) return Response.json({ error: 'quota or server refusal' }, { status: options.chatError })
      return new Response(path === '/api/chat'
        ? '{"message":{"content":"ok"},"done":true,"done_reason":"stop"}\n'
        : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }
    throw new Error(`Unexpected hosted request: ${path}`)
  }))
  return seen
}
async function send(settings: AppSettings, model: string, content = 'hello', signal?: AbortSignal) {
  let answer = ''
  for await (const chunk of streamProviderChat({
    settings, model, messages: [{ role: 'user', content }], temperature: 0,
    getSecret: () => 'fixture-token', signal
  } as never)) answer += chunk
  return answer
}
beforeEach(() => {
  clearOllamaRuntimeFacts()
  recordProviderContexts(endpoint, [])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('provider maximum context', () => {
  it.each([true, false])('uses reported 262K above lower saved limits, cloud=%s', async (cloud) => {
    const seen = provider()
    const { settings, connection, model } = settingsFor(cloud)
    const content = 'BEGIN EVIDENCE ' + 'x'.repeat(450000) + ' END EVIDENCE'
    expect(await send(settings, model, content)).toBe('ok')
    const chat = seen.find((request) => request.path.endsWith('/chat') || request.path.endsWith('/completions'))!
    expect(chat.body?.model).toBe('m')
    expect(chat.body?.messages).toEqual([{ role: 'user', content }])
    if (cloud) expect(chat.body?.options).toMatchObject({ num_ctx: 262144, num_predict: 8192 })
    else expect(chat.body?.max_tokens).toBe(8192)
    expect(seen.map((request) => request.path)).toEqual(['/v1/models', cloud ? '/api/chat' : '/v1/chat/completions'])
    expect(seen.every((request) => request.authorization === 'Bearer fixture-token')).toBe(true)
    expect(contextProvenance(settings, model)).toMatchObject({
      source: 'provider-declared', tokens: 262144, requestedContext: 262144,
      promptBudget: 251904, outputReserve: 8192
    })
    expect(resolveRoutingCapabilityProfile(settings, model, { local: false, connection }).contextWindow).toBe(262144)
    await send(settings, model)
    expect(seen.filter((request) => request.path === '/v1/models')).toHaveLength(1)
  })

  it('bounds a larger provider maximum at the product ceiling', async () => {
    const seen = provider({ rows: [{ id: 'm', context_length: 4194304 }] })
    const { settings, model } = settingsFor(true)
    await send(settings, model)
    expect(seen.at(-1)?.body?.options).toMatchObject({ num_ctx: 2097152 })
    expect(resolveModelCapabilities(settings, model).requestedContext).toBe(2097152)
  })

  it('uses authenticated Cloud show metadata when the catalog omits context', async () => {
    const seen = provider({ rows: [{ id: 'm' }], showWindow: 131072 })
    const { settings, model } = settingsFor(true)
    await send(settings, model)
    expect(seen.map((request) => request.path)).toEqual(['/v1/models', '/api/show', '/api/chat'])
    expect(seen.at(-1)?.body?.options).toMatchObject({ num_ctx: 131072 })
    expect(resolveModelCapabilities(settings, model)).toMatchObject({ contextCeiling: 131072, contextSource: 'provider-declared' })
  })

  it('deduplicates discovery across models on the same provider', async () => {
    const seen = provider({ rows: [{ id: 'm', context_length: 262144 }, { id: 'other', context_length: 131072 }] })
    const { settings } = settingsFor(false)
    settings.models.connections[0]!.models.push('other')
    settings.models.capabilityProfiles.other = { ...profile }
    await prepareModelWindows(settings, ['m', 'other'], () => 'fixture-token')
    expect(seen).toHaveLength(1)
    expect(resolveModelCapabilities(settings, 'other').contextCeiling).toBe(131072)
  })

  it('refreshes expired limits before sending the next prompt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { settings, model } = settingsFor(true)
    provider()
    await send(settings, model)
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
    const refreshed = provider({ rows: [{ id: 'm', context_length: 65536 }] })
    await send(settings, model)
    expect(refreshed.map((request) => request.path)).toEqual(['/v1/models', '/api/chat'])
    expect(refreshed.at(-1)?.body?.options).toMatchObject({ num_ctx: 65536 })
  })

  it.each([true, false])('rejects missing provider metadata without guessing, cloud=%s', async (cloud) => {
    const seen = provider({ rows: [{ id: 'm' }] })
    const { settings, model } = settingsFor(cloud)
    recordProviderContexts('https://different-provider.test/v1', [{ id: 'm', context_length: 262144 }])
    await expect(send(settings, model)).rejects.toThrow(/Cannot read the maximum context/)
    expect(seen.some((request) => request.path.endsWith('/chat') || request.path.endsWith('/completions'))).toBe(false)
  })

  it.each([0, -1, 511, 262144.5, '262144'])('rejects invalid advertised context %s', async (context_length) => {
    const seen = provider({ rows: [{ id: 'm', context_length }] })
    const { settings, model } = settingsFor(false)
    await expect(send(settings, model)).rejects.toThrow(/Cannot read the maximum context/)
    expect(seen).toHaveLength(1)
  })

  it('does not restore a Cloud model removed from the refreshed catalog', async () => {
    const seen = provider({ rows: [] })
    const { settings, model } = settingsFor(true)
    await expect(send(settings, model)).rejects.toThrow(/unavailable in the Eris Cloud catalog/)
    expect(seen.map((request) => request.path)).toEqual(['/v1/models'])
  })

  it('keeps the global ceiling for configured Cloud models', async () => {
    const seen = provider({ showWindow: 262144 })
    const { settings, model } = settingsFor(true)
    settings.models.capabilityProfiles[model]!.enabled = false
    settings.models.connections[0]!.modelLimits = undefined
    await send(settings, model)
    expect(seen.at(-1)?.body?.options).toMatchObject({ num_ctx: 32768 })
    expect(resolveModelCapabilities(settings, model).contextCeiling).toBe(32768)
  })

  it('surfaces a Cloud quota refusal without retrying a smaller context', async () => {
    const seen = provider({ chatError: 429 })
    const { settings, model } = settingsFor(true)
    await expect(send(settings, model)).rejects.toThrow()
    expect(seen.map((request) => request.path)).toEqual(['/v1/models', '/api/chat'])
  })

  it('cancels provider metadata discovery before inference', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      controller.abort(new Error('cancelled discovery'))
      init?.signal?.throwIfAborted()
      return Response.json({ data: [] })
    })
    vi.stubGlobal('fetch', fetch)
    const { settings, model } = settingsFor(false)
    await expect(send(settings, model, 'hello', controller.signal)).rejects.toThrow(/cancelled discovery/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
