import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase } from '../electron/main/services/chat-database'
import {
  conversationContext,
  invalidateConversationMemory,
  memoryKey,
  saveMemoryControls,
  warmConversationMemory
} from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import { emptyMemoryControls } from '../src/shared/context-memory'
let db: ChatDatabase, folder: string
const settings = () => structuredClone(getDefaults())
function save(id: string, count = 1001) {
  db.save({
    id,
    title: 'History',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content: i === 2 ? 'Remember: checkout must use CAD' : `Discussion ${i}`,
      createdAt: 1
    }))
  })
}
beforeEach(() => {
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  folder = mkdtempSync(join(tmpdir(), 'eris-memory-'))
  db = new ChatDatabase(folder)
  vi.mocked(workspaceRequest).mockImplementation(async (req) => {
    if (req.type === 'context-controls') return db.memoryControls(req.id, req.write) as never
    if (req.type === 'context-page') return db.contextPage(req.id, req.before) as never
    throw Error('Unexpected request')
  })
})
afterEach(() => {
  contextMemoryStore.clear()
  db.close()
  rmSync(folder, { recursive: true, force: true })
})
it('keeps excluded pins excluded after RAM eviction and database restart', async () => {
  save('t', 1)
  await saveMemoryControls(null, 't', {
    ...emptyMemoryControls(),
    pinned: [{ id: 'p', text: 'Remember: currency CAD' }],
    forgotten: ['p']
  })
  let result = await conversationContext(null, 't', 'currency', settings())
  expect(result.prompt.text).not.toContain('CAD')
  invalidateConversationMemory(null, 't')
  db.close()
  db = new ChatDatabase(folder)
  result = await conversationContext(null, 't', 'currency', settings())
  expect(result.inspection.controls.pinned).toHaveLength(1)
  expect(result.inspection.facts.some((f) => f.sourceId === 'p')).toBe(false)
  expect(db.get('t')!.messageCount).toBe(1)
})

describe('canonical context hydration', () => {
  it('hydrates 10,001 saved messages, keeps them warm and reconstructs after RAM eviction', async () => {
    save('t', 10001)
    let result = await conversationContext(null, 't', 'checkout currency', settings())
    expect(result.prompt.text).toContain('CAD')
    expect(result.prompt.manifest.retainedMessages).toBe(10001)
    const calls = vi.mocked(workspaceRequest).mock.calls.length
    await conversationContext(null, 't', 'checkout', settings())
    expect(vi.mocked(workspaceRequest).mock.calls).toHaveLength(calls)
    await saveMemoryControls(null, 't', {
      ...emptyMemoryControls(),
      pinned: [{ id: 'p', text: 'Test money rounding' }]
    })
    invalidateConversationMemory(null, 't')
    result = await conversationContext(null, 't', 'money', settings())
    expect(result.prompt.text).toContain('Test money rounding')
    expect(memoryKey(null, 't')).not.toBe(memoryKey(folder, 't'))
  })
  it('does not resurrect a cleared thread when its page finishes late', async () => {
    save('t')
    let release: (() => void) | undefined
    vi.mocked(workspaceRequest).mockImplementation(async (req) => {
      if (req.type === 'context-controls') return emptyMemoryControls() as never
      if (req.type === 'context-page') {
        await new Promise<void>((r) => {
          release = r
        })
        return db.contextPage('t') as never
      }
      throw Error('Unexpected')
    })
    const warming = warmConversationMemory(null, 't', settings())
    while (!release) await new Promise<void>((r) => setImmediate(r))
    invalidateConversationMemory(null, 't')
    release()
    await warming
    expect(contextMemoryStore.has(memoryKey(null, 't'))).toBe(false)
  })
  it('retries mixed-revision reads and publishes only one consistent snapshot', async () => {
    save('t')
    let pages = 0
    vi.mocked(workspaceRequest).mockImplementation(async (req) => {
      if (req.type === 'context-controls') return emptyMemoryControls() as never
      if (req.type === 'context-page') {
        const page = db.contextPage('t', req.before)
        if (++pages === 1)
          db.append('t', {
            id: 'new',
            role: 'user',
            content: 'Remember: current receipt',
            createdAt: 2
          })
        return page as never
      }
      throw Error('Unexpected')
    })
    const result = await conversationContext(null, 't', 'receipt', settings())
    expect(result.prompt.manifest.totalMessages).toBe(1002)
    expect(result.prompt.text).toContain('current receipt')
    expect(result.prompt.manifest.revision).toBe(db.contextPage('t')!.revision)
  })
  it('reports partial coverage at the configured message cap and clears immediately when disabled', async () => {
    save('t')
    const config = settings()
    config.agent.contextMemory.maxMessages = 500
    const result = await conversationContext(null, 't', 'Discussion', config)
    expect(result.prompt.manifest).toMatchObject({
      retainedMessages: 500,
      totalMessages: 1001,
      coverage: 'partial'
    })
    config.agent.contextMemory.enabled = false
    const disabled = await conversationContext(null, 't', 'Discussion', config)
    expect(disabled.prompt.manifest.coverage).toBe('disabled')
    expect(contextMemoryStore.logicalBytes).toBe(0)
  })
})

it('does not inherit remote-sharing policy from another workspace warming concurrently', async () => {
  save('t')
  const own = settings()
  own.agent.contextMemory.shareWithRemoteModels = false
  vi.mocked(workspaceRequest).mockImplementation(async (req) => {
    if (req.type === 'context-controls') return emptyMemoryControls() as never
    if (req.type === 'context-page') {
      const page = db.contextPage('t', req.before)
      contextMemoryStore.configure({ ...own.agent.contextMemory, shareWithRemoteModels: true })
      return page as never
    }
    throw Error('Unexpected request')
  })
  const result = await conversationContext(null, 't', 'checkout', own)
  expect(result.prompt.allowRemote).toBe(false)
})
