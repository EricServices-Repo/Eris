import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const h = vi.hoisted(() => ({
  sent: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>,
  events: [] as Array<{ type: string; data: { revoked: string[]; remaining: number } }>,
  released: [] as string[]
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
  releaseLocalChatSession: (key: string) => h.released.push(key)
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
import { leaseMemoryEvidence, withEligibleMemory } from '../electron/main/services/memory-dispatch'
import { compactAgentMessages } from '../electron/main/services/agent/compaction'
import { streamModelChat } from '../electron/main/services/chat-runtime'
import { getDefaults } from '../electron/main/services/settings'
import * as profileSettings from '../electron/main/services/settings'
import { emptyMemoryControls, type MemoryPrompt } from '../src/shared/context-memory'
import type { AppSettings } from '../src/shared/settings-schema'

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
    const { messages } = await withEligibleMemory(compacted.messages, LOCAL)
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
  expect((await withEligibleMemory(messages, REMOTE)).messages).toBe(messages)
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
    await withEligibleMemory(original, LOCAL)
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
      REMOTE
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
    await withEligibleMemory(original, LOCAL)
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
      REMOTE
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
      LOCAL
    )
    await expect(
      withEligibleMemory(
        [
          { role: 'system', content: 'Child task PRIVATE-A', contextBundle: { taskId: 'child' } },
          { role: 'user', content: 'Review PRIVATE-A' }
        ],
        REMOTE
      )
    ).rejects.toThrow(/different task/)
  })
})
