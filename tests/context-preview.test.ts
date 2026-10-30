import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import {
  conversationContext,
  inspectConversationMemory
} from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import {
  compileTaskContext,
  memoryForDestination
} from '../electron/main/services/agent/context-compiler'
import { previewContextDispatch } from '../electron/main/services/context-dispatch'
import { contextBudgetTokens } from '../electron/main/services/agent/context-budget'
import { createTaskContract } from '../electron/main/services/task-intake'
import { getDefaults } from '../electron/main/services/settings'
import {
  HISTORY_PAGE_MESSAGES,
  historyView,
  pageAround,
  windowAt
} from '../src/shared/chat-history-window'
import type { AppSettings, ChatThread } from '../src/shared/settings-schema'

const LOCAL = 'builtin:test.gguf'
const REMOTE = 'openai:gpt-test'
const PRIVATE = 'PRIVATE-PREVIEW'
const settings = (share = false): AppSettings => {
  const value = structuredClone(getDefaults())
  Object.assign(value.agent.contextMemory, {
    foregroundDeadlineMs: 2000,
    shareWithRemoteModels: share
  })
  return value
}
const row = (id: string, content: string) => ({
  id,
  role: 'user' as const,
  content,
  createdAt: 1
})
let dir: string
let db: ChatDatabase
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eris-preview-'))
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  db = new ChatDatabase(dir)
  vi.mocked(workspaceRequest).mockImplementation(
    async (request) =>
      (await handleWorkspaceRequest({ ...request, dir } as WorkspaceRequest)) as never
  )
  const thread: ChatThread = {
    id: 't',
    title: 'History',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: [row('a', `Remember: checkout uses ${PRIVATE}`), row('b', 'Unrelated note')]
  }
  db.save(thread)
})
afterEach(() => {
  closeChatDatabases()
  rmSync(dir, { recursive: true, force: true })
})

describe('RAM-CTX-035 preview parity', () => {
  it('matches the real compiler for the same query and destination', async () => {
    const value = settings(false)
    const { prompt } = await conversationContext(null, 't', 'checkout', value)
    for (const model of [LOCAL, REMOTE]) {
      const preview = previewContextDispatch({
        prompt,
        model,
        query: 'checkout',
        root: null,
        settings: value
      })
      const real = compileTaskContext({
        task: createTaskContract({
          workspacePath: null,
          text: 'checkout',
          plan: {
            intent: 'answer',
            agentId: 'chat',
            agentName: 'Chat',
            models: { chat: model, tools: model },
            toolPolicy: 'none'
          } as never
        }),
        guidance: '',
        ...memoryForDestination(prompt, model),
        project: '',
        retrieval: '',
        maxInputTokens: contextBudgetTokens(value, model)
      })
      expect(preview.counts).toEqual(real.bundle.counts)
      expect(preview.items.map((item) => [item.id, item.status, item.reason])).toEqual(
        real.bundle.items.map((item) => [item.id, item.status, item.reason])
      )
    }
  })
  it('shows a remote destination will not receive local-only facts', async () => {
    const value = settings(false)
    const local = await inspectConversationMemory(null, 't', 'checkout', value, LOCAL)
    const remote = await inspectConversationMemory(null, 't', 'checkout', value, REMOTE)
    expect(local.preview).toMatchObject({ destination: 'local' })
    expect(local.preview!.counts.sent).toBeGreaterThan(0)
    expect(remote.preview).toMatchObject({ destination: 'remote', counts: { sent: 0 } })
    expect(remote.preview!.items[0]).toMatchObject({ reason: 'destination-policy' })
  })
  it('shows a remote destination the facts when sharing is on', async () => {
    const shared = await inspectConversationMemory(null, 't', 'checkout', settings(true), REMOTE)
    expect(shared.preview!.counts.sent).toBeGreaterThan(0)
  })
  it('holds no source text in the preview record', async () => {
    const inspection = await inspectConversationMemory(null, 't', 'checkout', settings(), LOCAL)
    expect(JSON.stringify(inspection.preview)).not.toContain(PRIVATE)
  })
  it('has no destination to preview for Auto', async () => {
    const auto = await inspectConversationMemory(null, 't', 'checkout', settings(), 'auto')
    expect(auto.preview).toBeUndefined()
    expect(auto.facts.length).toBeGreaterThan(0)
  })
  it('reuses the task scope a turn resolved', async () => {
    const value = settings()
    expect((await inspectConversationMemory(null, 't', 'checkout', value)).projectRoot).toBe(
      undefined
    )
    await conversationContext(null, 't', 'checkout', value, { projectRoot: '/repo/a' })
    expect((await inspectConversationMemory(null, 't', 'checkout', value)).projectRoot).toBe(
      '/repo/a'
    )
  })
})

describe('bounded source navigation', () => {
  const page = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => row(`m${start + i}`, 'text'))
  it('centres a source without passing the live tail', () => {
    expect(pageAround(1000, 5000)).toEqual({
      before: 1000 + HISTORY_PAGE_MESSAGES / 2,
      limit: HISTORY_PAGE_MESSAGES
    })
    expect(pageAround(4990, 5000).before).toBe(5000)
  })
  it('shows one page and marks the gap instead of loading what is between', () => {
    const window = windowAt('t', 970, page(970, HISTORY_PAGE_MESSAGES))
    const view = historyView(window, {
      id: 't',
      messageOffset: 5000,
      messages: page(5000, 60)
    } as ChatThread)
    expect(view.gap).toBe(true)
    expect(view.start).toBe(970)
    expect(view.messages).toHaveLength(HISTORY_PAGE_MESSAGES)
    expect(view.messages.map((message) => message.id)).toContain('m1000')
  })
})
