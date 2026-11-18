import { resolveRoutingCapabilityProfile } from '../electron/main/services/model-capability-ranking'
import { modelInputBudget } from '../src/shared/model-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

import {
  resolveModelCapabilities,
  contextProvenance
} from '../electron/main/services/model-capabilities'
import { streamOllamaChat } from '../electron/main/services/ollama-chat'
import {
  clearOllamaRuntimeFacts,
  isPartlyOnCpu,
  noteOllamaOutOfMemory,
  observeOllamaPlacement,
  ollamaPlacement,
  ollamaRequestWindow,
  prepareModelWindows,
  UNVERIFIED_WINDOW
} from '../electron/main/services/ollama-runtime'
import { streamProviderChat } from '../electron/main/services/chat-runtime'
import { ModelStreamError } from '../electron/main/services/model-sse'
import { estimateContextTokens } from '../src/shared/token-estimate'
import type { AppSettings, ModelConnection } from '../src/shared/settings-schema'

vi.mock('../electron/main/services/usage-stats', async (original) => ({
  ...(await original<typeof import('../electron/main/services/usage-stats')>()),
  recordModelUsage: () => undefined
}))

type ChatBody = {
  model: string
  messages: Array<{ role: string; content: string; tool_name?: string; tool_calls?: unknown[] }>
  keep_alive: string | number
  options: { num_ctx: number; num_predict?: number; temperature: number }
  tools?: unknown[]
  think?: boolean | string
}

/** The documented native protocol, including Ollama's front-of-prompt truncation. */
function fakeOllama(behaviour: {
  contextLength?: number
  ps?: Record<string, unknown>
  show?: number
  chat?: string[]
  maximumLoad?: { loaded?: number; error?: string }
  catalog?: unknown[]
  chatFailure?: string
}) {
  const seen: {
    chat: ChatBody[]
    v1: number
    show: number
    loads: ChatBody[]
    v1Bodies: Array<{ messages: Array<{ content: string }> }>
  } = { chat: [], v1: 0, show: 0, loads: [], v1Bodies: [] }
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: behaviour.catalog ?? [{ id: 'm' }] }))
        return
      }
      if (request.url === '/api/show') {
        seen.show++
        if (behaviour.show) return void ((response.statusCode = behaviour.show), response.end('{}'))
        response.end(
          JSON.stringify({
            model_info: {
              'general.architecture': 'llama',
              'llama.context_length': behaviour.contextLength ?? 8192
            }
          })
        )
        return
      }
      if (request.url === '/api/ps') {
        response.end(JSON.stringify({ models: behaviour.ps ? [behaviour.ps] : [] }))
        return
      }
      if (request.url === '/api/chat' && JSON.parse(raw).messages.length === 0) {
        seen.loads.push(JSON.parse(raw))
        if (behaviour.maximumLoad?.error) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: behaviour.maximumLoad.error }))
        } else {
          behaviour.ps = { name: 'm', size: 100, size_vram: 60,
            ...(behaviour.maximumLoad?.loaded ? { context_length: behaviour.maximumLoad.loaded } : {}) }
          response.end(JSON.stringify({ done: true, done_reason: 'load' }))
        }
        return
      }
      if (request.url === '/api/chat') {
        seen.chat.push(JSON.parse(raw) as ChatBody)
        if (behaviour.chatFailure) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: behaviour.chatFailure }))
          return
        }
        for (const line of behaviour.chat ?? [
          '{"message":{"content":"he"},"done":false}',
          '{"message":{"content":"llo"},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":2}'
        ])
          response.write(`${line}\n`)
        response.end()
        return
      }
      seen.v1++
      if (raw) seen.v1Bodies.push(JSON.parse(raw))
      response.setHeader('Content-Type', 'text/event-stream')
      response.end('data: {"choices":[{"delta":{"content":"compat"},"finish_reason":"stop"}]}\n\n')
    })
  })
  return { server, seen }
}

const start = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
    )
  )
const connectionAt = (baseUrl: string, over: Partial<ModelConnection> = {}): ModelConnection => ({
  id: 'ollama',
  name: 'Ollama',
  type: 'openai-compatible',
  provider: 'ollama',
  enabled: true,
  baseUrl,
  apiKeyRef: '',
  models: ['m'],
  ...over
})
const settingsFor = (connection: ModelConnection, contextWindow = 32768) =>
  ({
    models: { connections: [connection], contextWindow },
    agent: { contextMemory: {} }
  }) as unknown as AppSettings
const noSecret = () => null

describe('Ollama window management', () => {
  let server: Server | undefined
  beforeEach(clearOllamaRuntimeFacts)
  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('sends the verified window and keep_alive on the native route', async () => {
    const fake = fakeOllama({ contextLength: 16384 })
    server = fake.server
    const settings = settingsFor(connectionAt(await start(server)))
    let text = ''
    for await (const chunk of streamProviderChat({
      settings,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      getSecret: noSecret
    } as never))
      text += chunk
    expect(text).toBe('hello')
    expect(fake.seen.v1).toBe(0)
    expect(fake.seen.chat[0]).toMatchObject({
      keep_alive: '30m',
      options: { num_ctx: 16384, temperature: 0.2 }
    })
  })

  const maximumSettings = (connection: ModelConnection) => {
    const settings = settingsFor(connection)
    settings.models.capabilityProfiles = {
      m: { enabled: true, contextWindowMode: 'model-maximum', contextWindow: 4096,
        tier: 'standard', toolCalling: 'text', reasoning: false, vision: false, costClass: 'low' }
    }
    return settings
  }
  const sendMaximum = async (settings: AppSettings, content = 'hi', signal?: AbortSignal) => {
    let text = ''
    for await (const chunk of streamProviderChat({
      settings, model: 'm', messages: [{ role: 'user', content }],
      temperature: 0, getSecret: noSecret, signal
    } as never)) text += chunk
    return text
  }

  it('uses the reported maximum over global, profile and connection limits with >128K input', async () => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { loaded: 262144 } })
    server = fake.server
    const settings = maximumSettings(connectionAt(await start(server), { modelLimits: { m: { contextWindow: 8192 } } }))
    const content = 'BEGIN EVIDENCE ' + 'x'.repeat(450000) + ' END EVIDENCE'
    expect(await sendMaximum(settings, content)).toBe('hello')
    expect(resolveRoutingCapabilityProfile(settings, 'm', { local: false, connection: settings.models.connections[0] }).contextWindow).toBe(262144)
    expect(fake.seen.loads).toHaveLength(1)
    expect(fake.seen.loads[0]).toMatchObject({ messages: [], options: { num_ctx: 262144 }, keep_alive: '30m' })
    expect(fake.seen.chat[0]?.options.num_ctx).toBe(262144)
    expect(fake.seen.chat[0]?.messages[0]?.content).toBe(content)
    expect(contextProvenance(settings, 'm')).toMatchObject({
      requestedContext: 262144, tokens: 262144, loaded: 262144, source: 'measured-allocation'
    })
    expect(resolveModelCapabilities(settings, 'm').promptBudget).toBe(modelInputBudget(262144, 16384))
    await sendMaximum(settings)
    expect(fake.seen.loads).toHaveLength(1) // live /api/ps avoids a redundant reload
  })

  it.each(['fit', 'max'] as const)('bypasses a learned smaller %s window for maximum-mode packing and dispatch', async (contextFit) => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { loaded: 262144 } })
    server = fake.server
    const connection = connectionAt(await start(server), { contextFit })
    const settings = maximumSettings(connection)
    settings.models.contextWindow = 262144
    await prepareModelWindows(settings, ['m'], noSecret)
    expect(noteOllamaOutOfMemory(connection, 'm', { requested: 262144, window: 262144 })).toBe(131072)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(262144)
    expect(ollamaRequestWindow(connection, 'm', 262144, { modelMaximum: true })).toBe(262144)

    const content = 'BEGIN ' + 'x'.repeat(450000) + ' END'
    await sendMaximum(settings, content)
    await observeOllamaPlacement(connection, 'm', 262144, null, {
      requested: 262144, explicit: true, modelMaximum: true
    })
    await sendMaximum(settings, content)
    expect(fake.seen.chat.map((body) => body.options.num_ctx)).toEqual([262144, 262144])
    expect(fake.seen.chat[1]?.messages[0]?.content).toBe(content)
    expect(resolveModelCapabilities(settings, 'm')).toMatchObject({
      contextCeiling: 262144, contextSource: 'measured-allocation'
    })
    // Maximum mode ignores, rather than overwrites, a fit learned in configured mode.
    expect(ollamaRequestWindow(connection, 'm', 262144)).toBe(131072)
    settings.models.capabilityProfiles.m!.enabled = false
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(131072)
    await sendMaximum(settings)
    expect(fake.seen.chat.at(-1)?.options.num_ctx).toBe(131072)
  })

  it.each(['fit', 'max'] as const)('does not learn a smaller %s window from CPU spill in maximum mode', async (contextFit) => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { loaded: 262144 } })
    server = fake.server
    const connection = connectionAt(await start(server), { contextFit })
    const settings = maximumSettings(connection)
    await sendMaximum(settings)
    await observeOllamaPlacement(connection, 'm', 262144, null, {
      requested: 262144, explicit: true, modelMaximum: true
    })
    expect(ollamaPlacement(connection, 'm')).toMatchObject({ sizeBytes: 100, vramBytes: 60 })
    expect(ollamaRequestWindow(connection, 'm', 262144)).toBe(262144)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(262144)
  })

  it('never retries or records a smaller window when inference runs out of memory after a successful maximum preload', async () => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { loaded: 262144 }, chatFailure: 'out of memory' })
    server = fake.server
    const connection = connectionAt(await start(server))
    const settings = maximumSettings(connection)
    await expect(sendMaximum(settings)).rejects.toThrow(/out of memory/)
    expect(fake.seen.loads).toHaveLength(1)
    expect(fake.seen.chat.map((body) => body.options.num_ctx)).toEqual([262144])
    expect(ollamaRequestWindow(connection, 'm', 262144)).toBe(262144)
    expect(noteOllamaOutOfMemory(connection, 'm', {
      requested: 262144, window: 262144, modelMaximum: true
    })).toBeNull()
    expect(ollamaRequestWindow(connection, 'm', 262144)).toBe(262144)
  })

  it.each([8192, undefined])('refuses a smaller or unreported allocation (%s) before sending conversation data', async (loaded) => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { loaded } })
    server = fake.server
    const settings = maximumSettings(connectionAt(await start(server)))
    await expect(sendMaximum(settings)).rejects.toThrow(/Cannot allocate the maximum context/)
    expect(fake.seen.chat).toHaveLength(0)
    expect(fake.seen.v1).toBe(0)
  })

  it('stops on allocation failure without retrying a smaller window', async () => {
    const fake = fakeOllama({ contextLength: 262144, maximumLoad: { error: 'out of memory' } })
    server = fake.server
    await expect(sendMaximum(maximumSettings(connectionAt(await start(server))))).rejects.toThrow(/Cannot allocate.*262,144/)
    expect(fake.seen.loads).toHaveLength(1)
    expect(fake.seen.chat).toHaveLength(0)
  })

  it('does not guess a maximum when model metadata is unavailable', async () => {
    const fake = fakeOllama({ show: 404 })
    server = fake.server
    await expect(sendMaximum(maximumSettings(connectionAt(await start(server))))).rejects.toThrow(/Cannot read the maximum context/)
    expect(fake.seen.loads).toHaveLength(0)
    expect(fake.seen.v1).toBe(0)
  })

  it('bounds an advertised maximum above the product ceiling without falling to the default window', async () => {
    const fake = fakeOllama({ contextLength: 4194304, maximumLoad: { loaded: 2097152 } })
    server = fake.server
    const settings = maximumSettings(connectionAt(await start(server)))
    await sendMaximum(settings)
    expect(fake.seen.chat[0]?.options.num_ctx).toBe(2097152)
    expect(resolveModelCapabilities(settings, 'm').requestedContext).toBe(2097152)
  })

  it('restores configured limits when the profile is disabled', async () => {
    const fake = fakeOllama({ contextLength: 262144 })
    server = fake.server
    const settings = maximumSettings(connectionAt(await start(server)))
    settings.models.capabilityProfiles.m!.enabled = false
    await sendMaximum(settings)
    expect(fake.seen.loads).toHaveLength(0)
    expect(fake.seen.chat[0]?.options.num_ctx).toBe(32768)
  })

  it('rejects maximum mode when a provider does not publish a context limit', async () => {
    const fake = fakeOllama({})
    server = fake.server
    const connection = connectionAt(await start(server), { id: 'custom', provider: 'custom' })
    await expect(sendMaximum(maximumSettings(connection))).rejects.toThrow(/Cannot read the maximum context/)
    expect(fake.seen.v1).toBe(0)
  })

  it('never asks for more than the setting or the model allows', async () => {
    const fake = fakeOllama({ contextLength: 131072 })
    server = fake.server
    const connection = connectionAt(await start(server))
    await prepareModelWindows(settingsFor(connection), ['m'], noSecret)
    expect(ollamaRequestWindow(connection, 'm', 32768)).toBe(32768)
    expect(resolveModelCapabilities(settingsFor(connection), 'm')).toMatchObject({
      contextCeiling: 32768,
      contextSource: 'runtime-plan'
    })
  })

  it('sends >128K input and a 262K window through the production provider adapter', async () => {
    const fake = fakeOllama({ contextLength: 262144 })
    server = fake.server
    const settings = settingsFor(
      connectionAt(await start(server), {
        modelLimits: { m: { contextWindow: 262144 } }
      })
    )
    const content = 'x'.repeat(450000)
    for await (const _ of streamProviderChat({
      settings,
      model: 'm',
      messages: [{ role: 'user', content }],
      temperature: 0,
      getSecret: noSecret
    } as never));
    expect(fake.seen.chat[0]?.options.num_ctx).toBe(262144)
    expect(fake.seen.chat[0]?.messages[0]?.content).toBe(content)
    expect(fake.seen.v1).toBe(0)
  })

  it('preserves >128K input through the OpenAI-compatible route with an explicit server limit', async () => {
    const fake = fakeOllama({})
    server = fake.server
    const settings = settingsFor(
      connectionAt(await start(server), {
        id: 'vllm',
        provider: 'custom',
        modelLimits: { m: { contextWindow: 262144 } }
      })
    )
    const content = 'x'.repeat(450000)
    for await (const _ of streamProviderChat({
      settings,
      model: 'm',
      messages: [{ role: 'user', content }],
      temperature: 0,
      getSecret: noSecret
    } as never));
    expect(fake.seen.chat).toHaveLength(0)
    expect(fake.seen.v1Bodies[0]?.messages[0]?.content).toBe(content)
    expect(fake.seen.show).toBe(0)
  })

  it('limits a large declaration to Ollama model metadata', async () => {
    const fake = fakeOllama({ contextLength: 8192 })
    server = fake.server
    const connection = connectionAt(await start(server), {
      modelLimits: { m: { contextWindow: 262144 } }
    })
    const settings = settingsFor(connection)
    await prepareModelWindows(settings, ['m'], noSecret)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(8192)
  })

  it('honours keep-loaded per connection', async () => {
    const fake = fakeOllama({})
    server = fake.server
    const settings = settingsFor(connectionAt(await start(server), { keepModelLoaded: true }))
    for await (const _ of streamProviderChat({
      settings,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      getSecret: noSecret
    } as never));
    expect(fake.seen.chat[0]?.keep_alive).toBe(-1)
  })

  it('agrees on requested, loaded and budget in diagnostics', async () => {
    const fake = fakeOllama({
      contextLength: 16384,
      ps: { name: 'm', size: 100, size_vram: 100, context_length: 16384 }
    })
    server = fake.server
    const connection = connectionAt(await start(server))
    const settings = settingsFor(connection)
    await prepareModelWindows(settings, ['m'], noSecret)
    await observeOllamaPlacement(connection, 'm', 16384, null)
    expect(contextProvenance(settings, 'm')).toMatchObject({
      source: 'measured-allocation',
      tokens: 16384,
      requested: 16384,
      loaded: 16384
    })
    expect(resolveModelCapabilities(settings, 'm').promptBudget).toBe(
      modelInputBudget(16384, Math.floor(16384 * 0.3))
    )
  })

  it('budgets to a smaller loaded window, but ignores a record from another num_ctx', async () => {
    const fake = fakeOllama({
      contextLength: 16384,
      ps: { model: 'm', size: 100, size_vram: 100, context_length: 4096 }
    })
    server = fake.server
    const connection = connectionAt(await start(server))
    const settings = settingsFor(connection)
    await prepareModelWindows(settings, ['m'], noSecret)
    await observeOllamaPlacement(connection, 'm', 16384, null)
    expect(resolveModelCapabilities(settings, 'm').contextCeiling).toBe(4096)
    await observeOllamaPlacement(connection, 'm', 8192, null)
    expect(resolveModelCapabilities(settings, 'm')).toMatchObject({
      contextCeiling: 16384,
      contextSource: 'runtime-plan'
    })
  })

  it('reports partial CPU placement', async () => {
    const fake = fakeOllama({ ps: { name: 'm', size: 100, size_vram: 62 } })
    server = fake.server
    const connection = connectionAt(await start(server))
    await observeOllamaPlacement(connection, 'm', 8192, null)
    const placement = ollamaPlacement(connection, 'm')!
    expect(isPartlyOnCpu(placement)).toBe(true)
    expect(placement).toMatchObject({ requestedWindow: 8192, vramBytes: 62 })
    expect(placement.loadedWindow).toBeUndefined()
  })

  const longPrompt = (turns: number, size: number) => [
    { role: 'system', content: 'SYSTEM CONTRACT' },
    ...Array.from({ length: turns }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `turn ${index} ${'x'.repeat(size)}`
    })),
    { role: 'user', content: 'final request' }
  ]

  it('keeps the system message on a long prompt that fits', async () => {
    const fake = fakeOllama({ contextLength: 4096 })
    server = fake.server
    const settings = settingsFor(connectionAt(await start(server)))
    for await (const _ of streamProviderChat({
      settings,
      model: 'm',
      messages: longPrompt(6, 1000),
      temperature: 0,
      getSecret: noSecret
    } as never));
    const sent = fake.seen.chat[0]!
    expect(sent.options.num_ctx).toBe(4096)
    expect(sent.messages[0]).toMatchObject({ role: 'system' })
    expect(sent.messages[0]?.content).toContain('SYSTEM CONTRACT')
    // Inside the window, so the server has no reason to cut from the front.
    expect(estimateContextTokens(JSON.stringify(sent.messages))).toBeLessThan(4096)
  })

  it('refuses a prompt over the window rather than let the server truncate it', async () => {
    const fake = fakeOllama({ contextLength: 4096 })
    server = fake.server
    const settings = settingsFor(connectionAt(await start(server)))
    const send = async () => {
      for await (const _ of streamProviderChat({
        settings,
        model: 'm',
        messages: longPrompt(40, 2000),
        temperature: 0,
        getSecret: noSecret
      } as never));
    }
    await expect(send()).rejects.toThrow(/context budget/)
    expect(fake.seen.chat).toEqual([])
  })
})

describe('servers that cannot be verified', () => {
  let server: Server | undefined
  beforeEach(clearOllamaRuntimeFacts)
  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('falls back to the compatible route and a conservative window', async () => {
    const fake = fakeOllama({ show: 404 })
    server = fake.server
    const settings = settingsFor(connectionAt(await start(server)))
    let text = ''
    for await (const chunk of streamProviderChat({
      settings,
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      getSecret: noSecret
    } as never))
      text += chunk
    expect(text).toBe('compat')
    expect(fake.seen.chat).toEqual([])
    expect(resolveModelCapabilities(settings, 'm')).toMatchObject({
      contextCeiling: UNVERIFIED_WINDOW,
      contextSource: 'unverified-window'
    })
  })

  it('treats any loopback server the same, and respects a smaller setting', () => {
    const lmStudio = connectionAt('http://127.0.0.1:1234/v1', { id: 'lm', provider: 'lmstudio' })
    expect(resolveModelCapabilities(settingsFor(lmStudio), 'm').contextSource).toBe(
      'unverified-window'
    )
    expect(resolveModelCapabilities(settingsFor(lmStudio, 2048), 'm').contextCeiling).toBe(2048)
  })

  it('leaves hosted providers on their configured ceiling', () => {
    const hosted = connectionAt('https://api.example.com/v1', { id: 'x', provider: 'openai' })
    expect(resolveModelCapabilities(settingsFor(hosted), 'm')).toMatchObject({
      contextCeiling: 32768,
      contextSource: 'configured-ceiling'
    })
  })
})

describe('streamOllamaChat', () => {
  let server: Server | undefined
  afterEach(() => {
    server?.close()
    server = undefined
  })
  const run = async (chat: string[], extra: Record<string, unknown> = {}) => {
    const fake = fakeOllama({ chat })
    server = fake.server
    const baseUrl = await start(server)
    const out: {
      text: string
      finish: unknown[]
      calls: unknown[]
      usage: unknown[]
      error?: unknown
      seen?: unknown
    } = {
      text: '',
      finish: [] as unknown[],
      calls: [] as unknown[],
      usage: [] as unknown[]
    }
    try {
      for await (const chunk of streamOllamaChat({
        baseUrl,
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        numCtx: 4096,
        keepAlive: '30m',
        onUsage: (usage) => out.usage.push(usage),
        onFinish: (...args) => out.finish.push(args),
        onNativeToolCalls: (calls) => out.calls.push(...calls),
        ...extra
      }))
        out.text += chunk
    } catch (error) {
      out.error = error
    }
    return { ...out, seen: fake.seen }
  }

  it('reports usage and maps tool calls to the shared shape', async () => {
    const result = await run([
      '{"message":{"content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"a"}}}]},"done":false}',
      '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":3}'
    ])
    expect(result.usage).toEqual([{ promptTokens: 9, completionTokens: 3, totalTokens: 12 }])
    expect(result.calls).toMatchObject([{ name: 'read', arguments: '{"path":"a"}' }])
    expect(result.finish).toEqual([['tool_calls', true, undefined]])
  })

  it('converts tool history to native fields', async () => {
    const result = await run(['{"message":{"content":"ok"},"done":true}'], {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'a1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }
          ]
        },
        { role: 'tool', content: 'file', tool_call_id: 'a1' }
      ]
    })
    expect(result.seen.chat[0]?.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }]
      },
      { role: 'tool', content: 'file', tool_name: 'read' }
    ])
  })

  it('omits tools when the caller forbids them', async () => {
    const tools = [{ type: 'function', function: { name: 'read' } }]
    const result = await run(['{"done":true}'], { tools, toolChoice: 'none' })
    expect(result.seen.chat[0]?.tools).toBeUndefined()
  })

  it('treats a stream without done as incomplete', async () => {
    const result = await run(['{"message":{"content":"par"},"done":false}'])
    expect(result.error).toBeInstanceOf(ModelStreamError)
    expect(result.finish).toMatchObject([[null, false, { reason: 'connection-closed' }]])
  })

  it('surfaces server errors and malformed lines as protocol errors', async () => {
    const errored = await run(['{"error":"model requires more memory"}'])
    expect(String(errored.error)).toContain('requires more memory')
    server?.close()
    const malformed = await run(['not json'])
    expect(malformed.finish).toMatchObject([[null, false, { reason: 'protocol-error' }]])
  })

  it('reports message.thinking as reasoning and never as answer text (#573)', async () => {
    const reasoning: string[] = []
    const result = await run(
      [
        '{"message":{"content":"","thinking":"weigh it"},"done":false}',
        '{"message":{"content":"Answer."},"done":true}'
      ],
      { onReasoning: (text: string) => reasoning.push(text) }
    )
    expect(result.text).toBe('Answer.')
    expect(reasoning.join('')).toBe('weigh it')
    expect(result.seen.chat[0]?.think).toBeUndefined()
  })

  it('sends think only for a chosen level (#573)', async () => {
    const off = await run(['{"done":true}'], { reasoning: 'off' })
    expect(off.seen.chat[0]?.think).toBe(false)
    server?.close()
    const high = await run(['{"done":true}'], { reasoning: 'high' })
    expect(high.seen.chat[0]?.think).toBe(true)
    server?.close()
    const oss = await run(['{"done":true}'], { reasoning: 'low', model: 'gpt-oss:20b' })
    expect(oss.seen.chat[0]?.think).toBe('low')
  })

  it('reports an output limit from done_reason', async () => {
    const result = await run(['{"message":{"content":"x"},"done":true,"done_reason":"length"}'])
    expect(result.finish).toEqual([['length', true, undefined]])
  })
})
