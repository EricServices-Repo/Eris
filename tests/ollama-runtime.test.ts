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
}

/** The documented native protocol, including Ollama's front-of-prompt truncation. */
function fakeOllama(behaviour: {
  contextLength?: number
  ps?: Record<string, unknown>
  show?: number
  chat?: string[]
}) {
  const seen: { chat: ChatBody[]; v1: number; show: number } = { chat: [], v1: 0, show: 0 }
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
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
      if (request.url === '/api/chat') {
        seen.chat.push(JSON.parse(raw) as ChatBody)
        for (const line of behaviour.chat ?? [
          '{"message":{"content":"he"},"done":false}',
          '{"message":{"content":"llo"},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":2}'
        ])
          response.write(`${line}\n`)
        response.end()
        return
      }
      seen.v1++
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
    expect(resolveModelCapabilities(settings, 'm').promptBudget).toBe(Math.floor(16384 * 0.65))
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

  it('reports an output limit from done_reason', async () => {
    const result = await run(['{"message":{"content":"x"},"done":true,"done_reason":"length"}'])
    expect(result.finish).toEqual([['length', true, undefined]])
  })
})
