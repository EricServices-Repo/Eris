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
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import {
  conversationContext,
  inspectConversationMemory,
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
const dispatchContextRequest = async (req: WorkspaceRequest) =>
  (await handleWorkspaceRequest({ ...req, dir: folder } as WorkspaceRequest)) as never
beforeEach(() => {
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  folder = mkdtempSync(join(tmpdir(), 'eris-memory-'))
  db = new ChatDatabase(folder)
  vi.mocked(workspaceRequest).mockImplementation(dispatchContextRequest)
})
afterEach(() => {
  contextMemoryStore.clear()
  closeChatDatabases()
  db.close()
  rmSync(folder, { recursive: true, force: true })
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
      return dispatchContextRequest(req)
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
      return dispatchContextRequest(req)
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
    return dispatchContextRequest(req)
  })
  const result = await conversationContext(null, 't', 'checkout', own)
  expect(result.prompt.allowRemote).toBe(false)
})

it('inspects durable controls and cutoff counts while recall is disabled', async () => {
  save('t', 4)
  const saved = {
    ...emptyMemoryControls(),
    forgotten: ['0'],
    pinned: [{ id: 'old', text: 'Saved note' }],
    afterOrdinal: 2
  }
  db.memoryControls('t', saved)
  const config = settings()
  config.agent.contextMemory.enabled = false
  const inspected = await inspectConversationMemory(null, 't', '', config)
  expect(inspected.controls).toMatchObject(saved)
  expect(inspected.controlsAvailable).toBe(true)
  expect(inspected.manifest).toMatchObject({
    coverage: 'disabled',
    totalMessages: 4,
    retainedMessages: 0
  })
  await saveMemoryControls(null, 't', {
    ...inspected.controls,
    pinned: [...inspected.controls.pinned, { id: 'new', text: 'New note' }]
  })
  expect(db.memoryControls('t')).toMatchObject({ forgotten: ['0'], afterOrdinal: 2 })
  expect(db.memoryControls('t').pinned.map((p) => p.id)).toEqual(['old', 'new'])
  invalidateConversationMemory(null, 't')
  db.close()
  db = new ChatDatabase(folder)
  config.agent.contextMemory.enabled = true
  expect((await inspectConversationMemory(null, 't', 'note', config)).controls.pinned).toHaveLength(
    2
  )
})
it('preserves editable canonical controls when hydration fails', async () => {
  save('t', 3)
  db.memoryControls('t', {
    ...emptyMemoryControls(),
    forgotten: ['0'],
    pinned: [{ id: 'old', text: 'Saved note' }]
  })
  vi.mocked(workspaceRequest).mockImplementation(async (req) => {
    if (req.type === 'context-page') throw Error('Hydration unavailable')
    return dispatchContextRequest(req)
  })
  const inspected = await inspectConversationMemory(null, 't', 'note', settings())
  expect(inspected.controlsAvailable).toBe(true)
  expect(inspected.controls.pinned[0]?.id).toBe('old')
  expect(inspected.manifest).toMatchObject({
    coverage: 'unavailable',
    totalMessages: 3,
    reason: 'Hydration unavailable'
  })
})
it('fails closed when canonical controls cannot be read', async () => {
  save('t', 1)
  vi.mocked(workspaceRequest).mockRejectedValue(Error('Controls unavailable'))
  await expect(inspectConversationMemory(null, 't', '', settings())).rejects.toThrow(
    'Controls unavailable'
  )
})

it('inspects canonical controls while two background hydrations occupy all slots', async () => {
  save('t', 2)
  db.save({ ...db.get('t')!, id: 'warm-a' })
  db.save({ ...db.get('t')!, id: 'warm-b' })
  db.memoryControls('t', { ...emptyMemoryControls(), pinned: [{ id: 'p', text: 'Saved note' }] })
  const releases: Array<() => void> = []
  vi.mocked(workspaceRequest).mockImplementation(async (req) => {
    if (req.type === 'context-page' && req.id !== 't')
      await new Promise<void>((resolve) => releases.push(resolve))
    return dispatchContextRequest(req)
  })
  const warms = [
    warmConversationMemory(null, 'warm-a', settings()),
    warmConversationMemory(null, 'warm-b', settings())
  ]
  while (releases.length < 2) await new Promise<void>((resolve) => setImmediate(resolve))
  try {
    const inspected = await inspectConversationMemory(null, 't', 'note', settings())
    expect(inspected.manifest.coverage).toBe('unavailable')
    expect(inspected.controlsAvailable).toBe(true)
    expect(inspected.controls.pinned[0]?.id).toBe('p')
  } finally {
    releases.forEach((release) => release())
    await Promise.all(warms)
  }
})
