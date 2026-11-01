import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const h = vi.hoisted(() => ({
  sent: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
  events: [] as Array<{ type: string; data: { revoked: string[]; remaining: number } }>,
  beforePrepare: async (..._args: unknown[]): Promise<void> => {},
  realPrepare: null as unknown as typeof prepareModelWindows,
  nativePrepare: async () => {},
  released: [] as string[]
}))
vi.mock('../electron/main/services/ollama-runtime', async (original) => {
  const actual = await original<typeof import('../electron/main/services/ollama-runtime')>()
  h.realPrepare = actual.prepareModelWindows
  return { ...actual, prepareModelWindows: async (...args: unknown[]) => h.beforePrepare(...args) }
})
vi.mock('../electron/main/services/ollama-chat', () => ({
  streamOllamaChat: async function* (request: (typeof h.sent)[number]) {
    h.sent.push(request)
    yield 'ok'
  }
}))
vi.mock('../electron/main/services/openai-compatible', async (original) => ({
  ...(await original<object>()),
  streamOpenAICompatible: async function* (request: (typeof h.sent)[number]) {
    h.sent.push(request)
    yield 'ok'
  }
}))
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../electron/main/services/model-transport', async (original) => ({
  ...(await original<typeof import('../electron/main/services/model-transport')>()),
  activeDiagnosticsScope: () => ({
    onTaskEvent: (event: (typeof h.events)[number]) => h.events.push(event),
    adapter: {
      stream: async function* (request: (typeof h.sent)[number]) {
        h.sent.push(request)
        yield 'ok'
      }
    }
  })
}))
vi.mock('../electron/main/services/builtin-model', async (original) => ({
  ...(await original<typeof import('../electron/main/services/builtin-model')>()),
  releaseLocalChatSession: (key: string) => h.released.push(key),
  resolveExactBuiltinRef: (ref: string) => ref,
  streamBuiltinChat: async function* (request: {
    modelRef: string
    messages: Array<{ role: string; content: string }>
    prepareMessages?: () => Promise<Array<{ role: string; content: string }>>
  }) {
    await h.nativePrepare()
    const messages = request.prepareMessages ? await request.prepareMessages() : request.messages
    h.sent.push({ model: request.modelRef, messages })
    yield 'ok'
  }
}))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import {
  conversationContext,
  invalidateConversationMemory,
  saveMemoryControls
} from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  currentEvidenceScope,
  inEvidenceScope,
  leaseMemoryEvidence,
  runInEvidenceScope,
  withEligibleMemory
} from '../electron/main/services/memory-dispatch'
import type { prepareModelWindows } from '../electron/main/services/ollama-runtime'
import { countContextItems } from '../electron/main/services/agent/context-compiler'
import { compactAgentMessages } from '../electron/main/services/agent/compaction'
import { streamModelChat, streamProviderChat } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'
import * as profileSettings from '../electron/main/services/settings'
import { emptyMemoryControls, type MemoryPrompt } from '../src/shared/context-memory'
import type { AppSettings } from '../src/shared/settings-schema'

const DISPATCH_SETTINGS = { models: { connections: [] } } as unknown as AppSettings

const LOCAL = 'builtin:test.gguf'
const REMOTE = 'openai:gpt-test'
let db: ChatDatabase, folder: string, release: () => void
const settings = (patch: Partial<AppSettings['agent']['contextMemory']> = {}) => {
  const value = structuredClone(getDefaults())
  Object.assign(value.agent.contextMemory, { foregroundDeadlineMs: 2000 }, patch)
  return value
}
const message = (id: string, content: string) => ({
  id,
  role: 'user' as const,
  content,
  createdAt: 1
})
const history = (...messages: ReturnType<typeof message>[]) => ({
  id: 't',
  title: 'History',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 1,
  messages
})
const seed = () =>
  db.save(
    history(
      message('a', 'Remember: checkout uses PRIVATE-A currency'),
      message('b', 'Remember: checkout keeps KEPT-B rounding'),
      message('c', 'Unrelated closing note')
    )
  )
const recall = async (options?: Parameters<typeof settings>[0]): Promise<MemoryPrompt> =>
  (await conversationContext(null, 't', 'checkout', settings(options))).prompt
const lease = (prompt: MemoryPrompt) => {
  release = leaseMemoryEvidence({ root: null, threadId: 't', taskId: 'task', prompt })
}
async function dispatch(prompt: MemoryPrompt, model = LOCAL, sessionKey?: string, text?: string) {
  for await (const _ of streamModelChat({
    settings: settings(),
    model,
    messages: [
      { role: 'system', content: `Instructions\n\n${text ?? prompt.text}` },
      { role: 'user', content: 'What about checkout?' }
    ],
    temperature: 0,
    getSecret: () => null,
    sessionKey
  }));
  return h.sent.at(-1)!.messages[0]!.content
}
const forget = (...forgotten: string[]) =>
  saveMemoryControls(null, 't', { ...emptyMemoryControls(), forgotten })

beforeEach(() => {
  h.sent.length = h.events.length = h.released.length = 0
  h.beforePrepare = async () => {}
  h.nativePrepare = async () => {}
  release = () => undefined
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  folder = mkdtempSync(join(tmpdir(), 'eris-dispatch-'))
  db = new ChatDatabase(folder)
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) =>
      (await handleWorkspaceRequest({ ...req, dir: folder } as WorkspaceRequest)) as never
  )
  seed()
})
afterEach(() => {
  release()
  closeChatDatabases()
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('memory eligibility at dispatch', () => {
  it('drops a source excluded after selection and keeps the rest', async () => {
    const prompt = await recall()
    lease(prompt)
    expect(await dispatch(prompt)).toContain('PRIVATE-A')
    await forget('a')
    const sent = await dispatch(prompt)
    expect(sent).not.toContain('PRIVATE-A')
    expect(sent).toContain('KEPT-B')
    expect(h.events.find((event) => event.type === 'memory-revoked')?.data.remaining).toBe(
      prompt.items!.length - 1
    )
  })
  it('honors an exclusion saved between selection and the lease', async () => {
    const prompt = await recall()
    await forget('a')
    lease(prompt)
    expect(await dispatch(prompt)).not.toContain('PRIVATE-A')
  })
  it('honors a timeline cutoff saved after selection', async () => {
    const prompt = await recall()
    lease(prompt)
    await saveMemoryControls(null, 't', { ...emptyMemoryControls(), afterOrdinal: 1 })
    const sent = await dispatch(prompt)
    expect(sent).not.toContain('PRIVATE-A')
    expect(sent).toContain('KEPT-B')
  })
  it('keeps evidence when an unrelated control changes', async () => {
    const prompt = await recall()
    lease(prompt)
    await forget('c')
    const sent = await dispatch(prompt)
    expect(sent).toContain('PRIVATE-A')
    expect(sent).toContain('KEPT-B')
  })
  it('observes controls committed by an independent writer after selection without main invalidation', async () => {
    const prompt = await recall()
    expect(prompt.sourceVersion).toBeDefined()
    lease(prompt)
    const other = new ChatDatabase(folder)
    try {
      other.contextControls('t', { ...emptyMemoryControls(), forgotten: ['a'] })
    } finally {
      other.close()
    }
    const sent = await dispatch(prompt)
    expect(sent).not.toContain('PRIVATE-A')
    expect(sent).toContain('KEPT-B')
  })
  it('removes an item truncated by the compiler budget', async () => {
    const prompt = await recall()
    lease(prompt)
    const line = prompt.items!.find((item) => item.sourceId === 'a')!.line
    const text = prompt.text.slice(0, prompt.text.indexOf(line) + line.indexOf('] ') + 12)
    const marker = line.slice(0, line.indexOf('] '))
    await forget('a')
    const sent = await dispatch(prompt, LOCAL, undefined, text)
    expect(text).toContain(marker)
    expect(sent).not.toContain(marker)
    expect(sent).not.toContain('Remember: checkout uses')
  })
  it('drops all evidence when the conversation is deleted mid-run', async () => {
    const prompt = await recall()
    lease(prompt)
    db.remove('t')
    invalidateConversationMemory(null, 't')
    const sent = await dispatch(prompt)
    expect(sent).not.toContain('PRIVATE-A')
    expect(sent).not.toContain('KEPT-B')
    expect(sent).not.toContain('CONVERSATION MEMORY')
  })
  it('drops only the rewritten source during compilation', async () => {
    const prompt = await recall()
    lease(prompt)
    db.save(
      history(
        message('a', 'Remember: checkout was rewritten'),
        message('b', 'Remember: checkout keeps KEPT-B rounding'),
        message('c', 'Unrelated closing note')
      )
    )
    invalidateConversationMemory(null, 't')
    const sent = await dispatch(prompt)
    expect(sent).not.toContain('PRIVATE-A')
    expect(sent).toContain('KEPT-B')
  })
  it('keeps the item out after compaction retains the stale system prompt', async () => {
    const prompt = await recall()
    lease(prompt)
    await forget('a')
    await dispatch(prompt)
    const compacted = await compactAgentMessages({
      messages: [
        { role: 'system', content: `Instructions\n\n${prompt.text}` },
        { role: 'user', content: 'Continue' }
      ],
      goal: 'Continue',
      filesTouched: [],
      actionLog: [],
      treeSnapshot: null,
      priorMemory: '',
      settings: settings(),
      liteModel: LOCAL,
      temperature: 0,
      getSecret: () => null,
      skipLiteSummary: true
    })
    const { messages } = await withEligibleMemory(compacted.messages, LOCAL, DISPATCH_SETTINGS)
    expect(JSON.stringify(messages)).not.toContain('PRIVATE-A')
  })
  it('treats memory-pressure eviction as a cache event, not a revocation', async () => {
    const prompt = await recall()
    lease(prompt)
    contextMemoryStore.trimIdle()
    expect(await dispatch(prompt)).toContain('PRIVATE-A')
  })
  it('stops tracking a released lease', async () => {
    const prompt = await recall()
    lease(prompt)
    release()
    await forget('a')
    expect(await dispatch(prompt)).toContain('PRIVATE-A')
  })
  it('reseeds a local session once, on the revoking dispatch', async () => {
    const prompt = await recall()
    lease(prompt)
    await dispatch(prompt, LOCAL, 'gguf:job')
    expect(h.released).toEqual([])
    await forget('a')
    await dispatch(prompt, LOCAL, 'gguf:job')
    await dispatch(prompt, LOCAL, 'gguf:job')
    expect(h.released).toEqual(['gguf:job'])
  })
})

describe('memory destination at dispatch', () => {
  it('blocks a remote backend without opt-in and still allows a local one', async () => {
    const prompt = await recall()
    lease(prompt)
    expect(await dispatch(prompt, LOCAL)).toContain('PRIVATE-A')
    const remote = await dispatch(prompt, REMOTE)
    expect(remote).not.toContain('PRIVATE-A')
    expect(remote).not.toContain('KEPT-B')
    expect(await dispatch(prompt, LOCAL)).toContain('PRIVATE-A')
  })
  it('allows an opted-in remote until sharing is turned off mid-run', async () => {
    const shared = settings({ shareWithRemoteModels: true })
    vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(shared)
    const prompt = await recall({ shareWithRemoteModels: true })
    lease(prompt)
    expect(await dispatch(prompt, REMOTE)).toContain('PRIVATE-A')
    vi.mocked(profileSettings.getResolvedSettings).mockReturnValue(settings())
    expect(await dispatch(prompt, REMOTE)).not.toContain('PRIVATE-A')
    vi.mocked(profileSettings.getResolvedSettings).mockReturnValue(shared)
    expect(await dispatch(prompt, REMOTE)).not.toContain('PRIVATE-A')
  })
  it('drops evidence when recall is disabled mid-run', async () => {
    const prompt = await recall()
    lease(prompt)
    vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(settings({ enabled: false }))
    expect(await dispatch(prompt)).not.toContain('PRIVATE-A')
  })
})

it('leaves unrelated requests untouched while no memory is leased', async () => {
  const messages = [{ role: 'user', content: 'Hello' }]
  expect((await withEligibleMemory(messages, REMOTE, DISPATCH_SETTINGS)).messages).toBe(messages)
})

// RAM-CTX-016: compiler metadata is accounting, never evidence of clean lineage.
describe('derived compiler and native-call privacy', () => {
  it('withholds recompiled recovery/project text and restores sanitized original authority', async () => {
    const prompt = await recall()
    lease(prompt)
    const original = [
      {
        role: 'system',
        content: `Keep the original scope.\n${prompt.text}`,
        contextBundle: { taskId: 'task' }
      },
      { role: 'user', content: 'What about checkout?' }
    ]
    await withEligibleMemory(original, LOCAL, DISPATCH_SETTINGS)
    const recovered = await withEligibleMemory(
      [
        {
          role: 'system',
          content: 'Recompiled project summary PRIVATE-A',
          contextBundle: { taskId: 'task' }
        },
        original[1],
        { role: 'assistant', content: 'Specialist aggregation PRIVATE-A' },
        { role: 'user', content: 'Outcome review PRIVATE-A' }
      ],
      REMOTE,
      DISPATCH_SETTINGS
    )
    expect(JSON.stringify(recovered.messages)).not.toContain('PRIVATE-A')
    expect(
      recovered.messages.some((message) => message.content.includes('Keep the original scope.'))
    ).toBe(true)
    expect(recovered.messages.some((message) => message.content === 'What about checkout?')).toBe(
      true
    )
    expect(h.events.some((event) => event.type === 'derived-context-withheld')).toBe(true)
  })
  it('does not treat new private native-call arguments as a clean empty assistant message', async () => {
    const prompt = await recall()
    lease(prompt)
    const original = [
      { role: 'system', content: prompt.text },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Continue' }
    ]
    await withEligibleMemory(original, LOCAL, DISPATCH_SETTINGS)
    const outgoing = await withEligibleMemory(
      [
        ...original.slice(0, 1),
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'new',
              type: 'function',
              function: { name: 'lookup', arguments: '{"secret":"PRIVATE-A"}' }
            }
          ]
        },
        { role: 'tool', content: 'Derived tool result PRIVATE-A', tool_call_id: 'new' },
        original[2]
      ],
      REMOTE,
      DISPATCH_SETTINGS
    )
    expect(JSON.stringify(outgoing.messages)).not.toContain('PRIVATE-A')
    expect(outgoing.messages.some((message) => 'tool_calls' in message)).toBe(false)
  })
  it('blocks cross-task recovery rather than replacing a child permission ceiling with the parent task', async () => {
    const prompt = await recall()
    lease(prompt)
    await withEligibleMemory(
      [
        { role: 'system', content: prompt.text, contextBundle: { taskId: 'parent' } },
        { role: 'user', content: 'Continue' }
      ],
      LOCAL,
      DISPATCH_SETTINGS
    )
    await expect(
      withEligibleMemory(
        [
          { role: 'system', content: 'Child task PRIVATE-A', contextBundle: { taskId: 'child' } },
          { role: 'user', content: 'Review PRIVATE-A' }
        ],
        REMOTE,
        DISPATCH_SETTINGS
      )
    ).rejects.toThrow(/different task/)
  })
})

describe('eligibility after asynchronous preparation', () => {
  it.each(['server', 'native'] as const)(
    'removes recall revoked while the %s model loads before serialization',
    async (kind) => {
      const prompt = await recall()
      lease(prompt)
      const model = kind === 'native' ? LOCAL : 'audit-model'
      const s = settings()
      s.models.connections = [
        {
          id: 'audit',
          name: 'Audit',
          enabled: true,
          type: 'openai-compatible',
          provider: 'custom',
          models: ['audit-model'],
          baseUrl: 'http://localhost:9011/v1',
          apiKeyRef: ''
        }
      ]
      const messages = [
        { role: 'system' as const, content: prompt.text },
        { role: 'user' as const, content: 'What about checkout?' }
      ]
      // The first eligibility check happened before loading, as it does in streamModelChat.
      await withEligibleMemory(messages, model, s)
      if (kind === 'server') h.beforePrepare = () => forget('a').then(() => {})
      else h.nativePrepare = () => forget('a').then(() => {})
      for await (const _ of streamProviderChat({
        settings: s,
        model,
        messages,
        temperature: 0,
        getSecret: () => null,
        sessionKey: 'test:late'
      }));
      expect(JSON.stringify(h.sent.at(-1)?.messages)).not.toContain('PRIVATE-A')
      expect(h.sent).toHaveLength(1)
      expect(h.released).toContain('test:late')
    }
  )

  const connection = (patch: object) => ({
    id: 'server',
    name: 'Server',
    enabled: true,
    type: 'openai-compatible' as const,
    provider: 'custom',
    models: ['server-model'],
    baseUrl: 'http://10.0.0.5:9011/v1',
    apiKeyRef: '',
    ...patch
  })
  const withConnection = (patch: object) => {
    const value = settings()
    value.models.connections = [connection(patch)] as AppSettings['models']['connections']
    return value
  }
  const send = async (value: AppSettings, signal?: AbortSignal, messages?: unknown[]) => {
    const prompt = (messages ?? [
      { role: 'system', content: (await recall()).text },
      { role: 'user', content: 'What about checkout?' }
    ]) as Array<{ role: 'system' | 'user'; content: string }>
    for await (const _ of streamProviderChat({
      settings: value,
      model: 'server-model',
      messages: prompt,
      temperature: 0,
      getSecret: () => null,
      signal
    }));
  }

  it('stops an approved endpoint receiving recall once approval is revoked during preparation', async () => {
    const url = 'http://10.0.0.5:9011/v1'
    const approved = withConnection({ recallApprovedUrl: url })
    const resolved = vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(approved)
    lease(await recall())
    h.beforePrepare = async () => {
      resolved.mockReturnValue(withConnection({}))
    }
    await send(approved)
    expect(h.sent).toHaveLength(1)
    expect(JSON.stringify(h.sent[0]!.messages)).not.toContain('PRIVATE-A')
    expect(JSON.stringify(h.sent[0]!.messages)).not.toContain('KEPT-B')
  })

  it('still sends recall to an endpoint whose approval stands', async () => {
    const approved = withConnection({ recallApprovedUrl: 'http://10.0.0.5:9011/v1' })
    vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(approved)
    lease(await recall())
    await send(approved)
    expect(JSON.stringify(h.sent[0]!.messages)).toContain('PRIVATE-A')
  })

  it('reports dispatch counts for the filtered payload, not the compiled one', async () => {
    const prompt = await recall()
    lease(prompt)
    // The bundle names each item by the marker its rendered line starts with.
    const items = prompt.items!.map((item) => ({
      id: item.id,
      kind: item.kind,
      ordinal: item.ordinal,
      status: 'sent',
      reason: 'fits-budget',
      sentChars: item.line.length,
      sourceDigest: /source (\S+);/.exec(item.line)![1]!
    }))
    const contextBundle = { taskId: 'task', items, counts: countContextItems(items as never) }
    const gone = prompt.items!.find((item) => item.text.includes('PRIVATE-A'))!
    const kept = prompt.items!.find((item) => item.text.includes('KEPT-B'))!
    h.beforePrepare = () => forget(gone.sourceId).then(() => {})
    const loopback = withConnection({ baseUrl: 'http://localhost:9011/v1' })
    vi.spyOn(profileSettings, 'getResolvedSettings').mockReturnValue(loopback)
    await send(loopback, undefined, [
      { role: 'system', content: prompt.text, contextBundle },
      { role: 'user', content: 'What about checkout?' }
    ])
    const { data } = h.events.filter((event) => event.type === 'context-dispatched').at(-1)!
    const dispatched = data as unknown as {
      counts: ReturnType<typeof countContextItems>
      items: Array<{ id: string; status: string; reason: string }>
    }
    expect(JSON.stringify(h.sent.at(-1)!.messages)).not.toContain('PRIVATE-A')
    expect(dispatched.items.find((item) => item.id === gone.id)).toMatchObject({
      status: 'omitted',
      reason: 'revoked-at-dispatch'
    })
    expect(dispatched.items.find((item) => item.id === kept.id)).toMatchObject({ status: 'sent' })
    expect(dispatched.counts).toEqual(countContextItems(dispatched.items as never))
    expect(dispatched.counts.omitted).toBe(1)
  })

  it.each(['server', 'native'])(
    'sends nothing when cancelled during the final %s check',
    async (kind) => {
      const prompt = await recall()
      lease(prompt)
      const ac = new AbortController()
      const value = withConnection({ baseUrl: 'http://localhost:9011/v1' })
      const canonical = vi.mocked(workspaceRequest).getMockImplementation()!
      // The native route checks again after the model loads, so aim at that later check.
      let armed = kind === 'server'
      h.nativePrepare = async () => {
        armed = true
      }
      vi.mocked(workspaceRequest).mockImplementation(async (req) => {
        if (req.type === 'context-header' && armed) ac.abort()
        return canonical(req)
      })
      const stream = streamProviderChat({
        settings: value,
        model: kind === 'native' ? LOCAL : 'server-model',
        messages: [
          { role: 'system', content: prompt.text },
          { role: 'user', content: 'What about checkout?' }
        ],
        temperature: 0,
        getSecret: () => null,
        signal: ac.signal
      })
      await expect(
        (async () => {
          for await (const _ of stream);
        })()
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(h.sent).toHaveLength(0)
    }
  )

  describe('through the real Ollama probe', () => {
    const ollama = (port: number) =>
      withConnection({
        id: 'ollama',
        provider: 'ollama',
        baseUrl: `http://localhost:${port}/v1`
      })
    const probeAnswer = () =>
      new Response(JSON.stringify({ model_info: { 'x.context_length': 8192 } }))
    const prepare = (...args: unknown[]) =>
      h.realPrepare(...(args as Parameters<typeof prepareModelWindows>))
    afterEach(() => vi.unstubAllGlobals())

    it('removes recall forgotten while a probe is outstanding', async () => {
      let probes = 0
      let answer = () => {}
      // After a send the runtime also reads placement, which is not a capability probe.
      vi.stubGlobal('fetch', async (url: string) => {
        if (!url.endsWith('/api/show')) return new Response('{}')
        probes++
        await new Promise<void>((resolve) => (answer = resolve))
        return probeAnswer()
      })
      h.beforePrepare = (...args) => {
        const prepared = prepare(...args)
        void forget('a').then(() => answer())
        return prepared
      }
      lease(await recall())
      await send(ollama(9012))
      expect(probes).toBe(1)
      expect(JSON.stringify(h.sent.at(-1)!.messages)).not.toContain('PRIVATE-A')
    })

    it('removes recall forgotten around a capability-cache hit', async () => {
      const value = ollama(9013)
      let probes = 0
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.endsWith('/api/show')) probes++
        return url.endsWith('/api/show') ? probeAnswer() : new Response('{}')
      })
      await prepare(value, ['server-model'], () => null)
      h.beforePrepare = async (...args) => {
        await prepare(...args)
        await forget('a')
      }
      lease(await recall())
      await send(value)
      expect(probes).toBe(1)
      expect(JSON.stringify(h.sent.at(-1)!.messages)).not.toContain('PRIVATE-A')
    })
  })
})

describe('evidence scopes', () => {
  const unrelated = [
    { role: 'system', content: 'B only' },
    { role: 'user', content: 'UNRELATED-REQUEST-B' }
  ]
  /** Request A in its own scope: it recalls, reaches a local model, and stays open. */
  async function requestA() {
    const scope = {}
    const prompt = await recall()
    await runInEvidenceScope(async () => {
      lease(prompt)
      await dispatch(prompt)
    }, scope)
    return { scope, prompt }
  }

  it.each([
    ['remote', REMOTE],
    ['native', LOCAL]
  ])('leaves an unrelated %s request exactly as it was', async (_name, model) => {
    await requestA()
    const out = await runInEvidenceScope(() => withEligibleMemory(unrelated, model, settings()))
    expect(out.messages).toBe(unrelated)
    expect(out.revoked).toBe(false)
  })

  it('leaves unrelated background work outside any request alone', async () => {
    await requestA()
    expect((await withEligibleMemory(unrelated, REMOTE, settings())).messages).toBe(unrelated)
  })

  it('does not throw on another request with its own compiled task', async () => {
    await requestA()
    const compiled = [
      { role: 'system', content: 'B contract', contextBundle: { taskId: 'task-b' } },
      { role: 'user', content: 'UNRELATED-REQUEST-B' }
    ]
    const out = await runInEvidenceScope(() => withEligibleMemory(compiled, REMOTE, settings()))
    expect(out.messages).toBe(compiled)
  })

  it('keeps two active requests from revoking each other', async () => {
    const { prompt } = await requestA()
    let leaseB = () => undefined as unknown
    const scopeB = {}
    const sentB = await runInEvidenceScope(async () => {
      leaseB = leaseMemoryEvidence({ root: null, threadId: 't', taskId: 'task-b', prompt })
      return withEligibleMemory(
        [
          { role: 'system', content: `Task B\n\n${prompt.text}` },
          { role: 'user', content: 'Goal of B' }
        ],
        REMOTE,
        settings()
      )
    }, scopeB)
    leaseB()
    const user = sentB.messages.filter((item) => item.role === 'user')
    expect(user.map((item) => item.content)).toEqual(['Goal of B'])
    expect(JSON.stringify(sentB.messages)).not.toContain('PRIVATE-A')
    expect(JSON.stringify(sentB.messages)).not.toContain('What about checkout?')
  })

  it('keeps each intent through compaction in overlapping requests', async () => {
    const { scope, prompt } = await requestA()
    const long = (text: string) => [
      { role: 'system' as const, content: 'Instructions' },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: `${text} step ${i}`
      }))
    ]
    const compactedB = await runInEvidenceScope(() =>
      compactAgentMessages({
        messages: long('Goal of B'),
        goal: 'Goal of B',
        filesTouched: [],
        actionLog: [],
        treeSnapshot: null,
        priorMemory: null,
        settings: settings(),
        liteModel: REMOTE,
        temperature: 0,
        getSecret: () => null
      })
    )
    expect(compactedB.messages.length).toBeLessThan(long('Goal of B').length)
    const b = await runInEvidenceScope(() =>
      withEligibleMemory(compactedB.messages, REMOTE, settings())
    )
    expect(JSON.stringify(b.messages)).toContain('Goal of B')
    expect(JSON.stringify(b.messages)).not.toContain('What about checkout?')
    const a = await runInEvidenceScope(
      () =>
        withEligibleMemory(
          [
            { role: 'system', content: `Instructions\n\n${prompt.text}` },
            { role: 'user', content: 'What about checkout?' },
            { role: 'assistant', content: 'It uses PRIVATE-A' }
          ],
          REMOTE,
          settings()
        ),
      scope
    )
    expect(JSON.stringify(a.messages)).not.toContain('PRIVATE-A')
  })

  it('still withholds derived text on a dependent reroute', async () => {
    const { scope } = await requestA()
    const out = await runInEvidenceScope(
      () =>
        withEligibleMemory(
          [
            { role: 'system', content: 'Rerouted' },
            { role: 'assistant', content: 'Derived from PRIVATE-A' }
          ],
          REMOTE,
          settings()
        ),
      scope
    )
    expect(JSON.stringify(out.messages)).not.toContain('Derived from PRIVATE-A')
  })

  it('still refuses to move derived text to another task inside the request', async () => {
    const { scope } = await requestA()
    await expect(
      runInEvidenceScope(
        () =>
          withEligibleMemory(
            [
              { role: 'system', content: 'Child', contextBundle: { taskId: 'child' } },
              { role: 'user', content: 'Review it' }
            ],
            REMOTE,
            settings()
          ),
        scope
      )
    ).rejects.toThrow(/different task/)
  })

  it('still removes recalled items that reach another scope', async () => {
    const { prompt } = await requestA()
    const out = await runInEvidenceScope(() =>
      withEligibleMemory(
        [
          { role: 'system', content: `Lost scope\n\n${prompt.text}` },
          { role: 'user', content: 'Something else' }
        ],
        REMOTE,
        settings()
      )
    )
    expect(JSON.stringify(out.messages)).not.toContain('PRIVATE-A')
  })

  it('treats a bundle for the leased task as that request, in any scope', async () => {
    const prompt = await recall()
    const scope = {}
    const bundle = { contextBundle: { taskId: 'task' } }
    await runInEvidenceScope(async () => {
      lease(prompt)
      await withEligibleMemory(
        [
          { role: 'system', content: `Task\n\n${prompt.text}`, ...bundle },
          { role: 'user', content: 'What about checkout?' }
        ],
        LOCAL,
        settings()
      )
    }, scope)
    const out = await runInEvidenceScope(() =>
      withEligibleMemory(
        [
          { role: 'system', content: 'Rebuilt', ...bundle },
          { role: 'assistant', content: 'Derived from PRIVATE-A' }
        ],
        REMOTE,
        settings()
      )
    )
    expect(JSON.stringify(out.messages)).not.toContain('Derived from PRIVATE-A')
  })

  it('follows a request through a stream and a dependent child', async () => {
    const scope = {}
    const seen: unknown[] = []
    async function* stream() {
      seen.push(currentEvidenceScope())
      await Promise.resolve()
      seen.push(currentEvidenceScope())
      yield 1
      seen.push(currentEvidenceScope())
    }
    await runInEvidenceScope(async () => {
      for await (const _ of stream());
      await runInEvidenceScope(
        async () => seen.push(currentEvidenceScope()),
        currentEvidenceScope()
      )
    }, scope)
    expect(seen).toEqual([scope, scope, scope, scope])
    expect(seen.every((item) => item === scope)).toBe(true)
  })

  it('gives every call of a wrapped handler a scope of its own', async () => {
    const handler = inEvidenceScope(async () => currentEvidenceScope())
    const [first, second] = await Promise.all([handler(), handler()])
    expect(first).toBeDefined()
    expect(first).not.toBe(second)
  })
})
