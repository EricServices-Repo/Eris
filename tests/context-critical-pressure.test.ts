import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const pressure = vi.hoisted(() => ({ state: 'critical' as 'normal' | 'constrained' | 'critical' }))
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../electron/main/services/inference-governor', async (original) => ({
  ...(await original<typeof import('../electron/main/services/inference-governor')>()),
  refreshContextMemoryPressure: () => ({ pressure: pressure.state })
}))

import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { ChatDatabase, closeChatDatabases } from '../electron/main/services/chat-database'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'
import { conversationContext, saveMemoryControls } from '../electron/main/services/context-memory'
import {
  contextMemoryStore,
  ContextMemoryStore,
  RECOVERY_RESERVATION_BYTES
} from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import { emptyMemoryControls } from '../src/shared/context-memory'

const THREAD = 'thread'
let db: ChatDatabase, folder: string
const settings = () => {
  const value = structuredClone(getDefaults())
  value.agent.contextMemory.foregroundDeadlineMs = 2000
  return value
}
const dispatch = async (req: WorkspaceRequest) =>
  (await handleWorkspaceRequest({ ...req, dir: folder } as WorkspaceRequest)) as never
const failing =
  (...types: string[]) =>
  async (req: WorkspaceRequest) => {
    if (types.includes(req.type)) throw new Error(`${req.type} unavailable`)
    return dispatch(req)
  }
const recall = (query: string, signal?: AbortSignal) =>
  conversationContext(null, THREAD, query, settings(), { signal })
async function pin(text: string) {
  const header = (await dispatch({ type: 'context-header', dir: folder, id: THREAD })) as {
    revision: number
  }
  expect(header).toBeTruthy()
  return saveMemoryControls(null, THREAD, {
    ...emptyMemoryControls(),
    pinned: [{ id: 'pin-1', text }]
  })
}

beforeEach(() => {
  pressure.state = 'critical'
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  contextMemoryStore.setPressureLimit(0)
  folder = mkdtempSync(join(tmpdir(), 'eris-pressure-'))
  db = new ChatDatabase(folder)
  db.save({
    id: THREAD,
    title: 'History',
    model: 'local:test',
    createdAt: 1,
    updatedAt: 1,
    messages: Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      content: i === 2 ? 'Remember: checkout must use CAD' : `Discussion ${i}`,
      createdAt: 1
    }))
  })
  vi.mocked(workspaceRequest).mockImplementation(dispatch)
})
afterEach(() => {
  contextMemoryStore.setPressureLimit(Infinity)
  contextMemoryStore.clear()
  closeChatDatabases()
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('recall at critical memory pressure', () => {
  it('still sends pins, with nothing resident in RAM', async () => {
    await pin('Always invoice in CAD')
    const { prompt } = await recall('what currency do we invoice in')
    expect(prompt.text).toContain('Always invoice in CAD')
    expect(contextMemoryStore.ledger.ownedBytes).toBe(0)
  })
  it('still searches durable history', async () => {
    const { prompt } = await recall('checkout currency CAD')
    expect(prompt.text).toContain('checkout must use CAD')
    expect(prompt.manifest.recallTier).toBe('durable-and-pins')
    expect(prompt.manifest.reason).toMatch(/Durable history and pinned notes/)
  })
  it('falls back to pins alone when the archive fails', async () => {
    await pin('Always invoice in CAD')
    vi.mocked(workspaceRequest).mockImplementation(failing('context-archive-search'))
    const { prompt } = await recall('invoice currency')
    expect(prompt.text).toContain('Always invoice in CAD')
    expect(prompt.manifest.recallTier).toBe('pins')
    expect(prompt.manifest.reason).toMatch(/Pinned notes were used/)
  })
  it('falls back to recent history when pins cannot be read', async () => {
    vi.mocked(workspaceRequest).mockImplementation(failing('context-controls'))
    const { prompt } = await recall('invoice currency')
    expect(prompt.text).toBe('')
    expect(prompt.manifest.recallTier).toBe('recent')
    expect(prompt.manifest.reason).toMatch(/Recent canonical messages remain available/)
  })
  it('respects exclusions and forgotten pins', async () => {
    await pin('Always invoice in CAD')
    await saveMemoryControls(null, THREAD, {
      ...emptyMemoryControls(),
      pinned: [{ id: 'pin-1', text: 'Always invoice in CAD' }],
      forgotten: ['pin-1', '2'],
      revision: 1
    })
    const { prompt } = await recall('invoice CAD checkout')
    expect(prompt.text).not.toContain('Always invoice in CAD')
    expect(prompt.text).not.toContain('checkout must use CAD')
  })
  it('fits the largest controls the schema allows', async () => {
    await saveMemoryControls(null, THREAD, {
      ...emptyMemoryControls(),
      pinned: Array.from({ length: 100 }, (_, i) => ({
        id: `pin-${i}`,
        text: `Always invoice in CAD ${i} `.padEnd(2000, 'x')
      })),
      forgotten: Array.from({ length: 2_500 }, (_, i) => `excluded-${i}`.padEnd(100, 'x'))
    })
    const { prompt } = await recall('invoice CAD')
    expect(prompt.manifest.recallTier).toBe('durable-and-pins')
    expect(prompt.text).toContain('Always invoice in CAD')
  })
  it('does not treat disabled recall as a reason to read history', async () => {
    const off = settings()
    off.agent.contextMemory.enabled = false
    const { prompt } = await conversationContext(null, THREAD, 'CAD', off)
    expect(prompt.text).toBe('')
  })
  it('keeps recovered evidence bound to its source for dispatch checks', async () => {
    await pin('Always invoice in CAD')
    const { prompt } = await recall('invoice')
    expect(prompt.namespace).toBeTruthy()
    expect(prompt.sourceVersion?.messageCount).toBe(40)
    expect(prompt.evidenceToken).toBeDefined()
  })
  it('shares with a remote model only when policy allows', async () => {
    await pin('Always invoice in CAD')
    expect((await recall('invoice')).prompt.allowRemote).toBe(false)
    const open = settings()
    open.agent.contextMemory.shareWithRemoteModels = true
    const { prompt } = await conversationContext(null, THREAD, 'invoice', open)
    expect(prompt.allowRemote).toBe(true)
  })
  it('releases its allowance afterwards', async () => {
    await recall('checkout CAD')
    expect(contextMemoryStore.ledger.reservedBytes).toBe(0)
    await recall('checkout CAD')
    expect(contextMemoryStore.ledger.reservedBytes).toBe(0)
  })
  it('reports recent history when selection itself is refused', async () => {
    const select = vi
      .spyOn(ContextMemoryStore.prototype, 'select')
      .mockImplementation(async function (this: ContextMemoryStore, key: string) {
        return this.unavailable(key, 'refused')
      })
    const { prompt } = await recall('checkout CAD')
    expect(select).toHaveBeenCalled()
    expect(prompt.manifest.recallTier).toBe('recent')
    expect(prompt.manifest.reason).toMatch(/optional RAM recall is paused/)
  })
  it('stops on user cancellation instead of falling back', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(recall('CAD', stop.signal)).rejects.toThrow()
  })
  it('names the tier outside pressure too', async () => {
    pressure.state = 'normal'
    contextMemoryStore.setPressureLimit(Infinity)
    const { prompt } = await recall('checkout CAD')
    expect(prompt.manifest.recallTier).toBe('ram')
  })
})

describe('recovery allowance', () => {
  it('works with an empty envelope and is charged to the ledger', () => {
    const store = new ContextMemoryStore()
    store.setPressureLimit(0)
    const reservation = store.reserveRecovery()
    expect(reservation?.bytes).toBe(RECOVERY_RESERVATION_BYTES)
    expect(store.ledger.reservedBytes).toBe(RECOVERY_RESERVATION_BYTES)
    reservation?.release()
    expect(store.ledger.reservedBytes).toBe(0)
  })
  it('is bounded in total and cannot grow', () => {
    const store = new ContextMemoryStore()
    const first = store.reserveRecovery()!
    expect(store.reserveRecovery()).toBeNull()
    expect(first.grow(1)).toBe(false)
    first.release()
    first.release()
    expect(store.reserveRecovery()).not.toBeNull()
  })
})
