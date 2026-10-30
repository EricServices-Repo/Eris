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
  invalidateConversationMemory,
  memoryKey,
  warmConversationMemory
} from '../electron/main/services/context-memory'
import {
  ContextMemoryStore,
  contextMemoryStore
} from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import {
  ContextMemorySettingsSchema,
  emptyMemoryControls,
  type ContextMemorySettings
} from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'

const MiB = 1024 ** 2
const config = (patch: Partial<ContextMemorySettings>) =>
  ContextMemorySettingsSchema.parse({ ...patch })
const message = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 1
})
const page = (id: string, chars: number) => ({
  revision: 1,
  total: 1,
  records: [{ ordinal: 0, message: message(id, 'x'.repeat(chars)) }],
  controls: emptyMemoryControls(),
  partial: false
})
const small = () => {
  const store = new ContextMemoryStore()
  store.configure(config({ maxMemoryMiB: 16, maxThreadMiB: 8, warmThreads: 4 }))
  return store
}
const committed = (store: ContextMemoryStore) => {
  const { ownedBytes, reservedBytes, pinnedBytes } = store.ledger
  return ownedBytes + reservedBytes + pinnedBytes
}
const envelope = (store: ContextMemoryStore) => store.ledger.envelopeBytes

describe('reservations', () => {
  it('refuses what the envelope cannot hold', () => {
    const store = small()
    expect(store.reserve('a', 17 * MiB)).toBeNull()
    expect(store.ledger.reservedBytes).toBe(0)
  })
  it('keeps concurrent reservations inside the envelope', () => {
    const store = small()
    const first = store.reserve('a', 10 * MiB)!
    expect(store.reserve('b', 10 * MiB)).toBeNull()
    expect(first.grow(8 * MiB)).toBe(false)
    expect(first.grow(4 * MiB)).toBe(true)
    expect(committed(store)).toBeLessThanOrEqual(envelope(store))
  })
  it('evicts other cold threads to admit an allocation', () => {
    const store = small()
    store.install('cold', page('c', 1_000_000), store.token('cold'))
    const before = store.ledger.ownedBytes
    expect(before).toBeGreaterThan(MiB)
    expect(store.reserve('new', 15 * MiB)).not.toBeNull()
    expect(store.has('cold')).toBe(false)
    expect(committed(store)).toBeLessThanOrEqual(envelope(store))
  })
  it('never evicts the thread being hydrated', () => {
    const store = small()
    store.install('a', page('a', 1_000_000), store.token('a'))
    expect(store.reserve('a', 15 * MiB)).toBeNull()
    expect(store.has('a')).toBe(true)
  })
  it('releases once however many times it is called', () => {
    const store = small()
    const first = store.reserve('a', 4 * MiB)!
    const second = store.reserve('b', 2 * MiB)!
    first.release()
    first.release()
    expect(store.ledger.reservedBytes).toBe(2 * MiB)
    expect(first.grow(1)).toBe(false)
    second.release()
    expect(store.ledger.reservedBytes).toBe(0)
  })
  it('moves bytes to owned in one step on install', () => {
    const store = small()
    const reservation = store.reserve('a', 3 * MiB)!
    store.install('a', page('a', 1000), store.token('a'), reservation)
    expect(store.ledger.reservedBytes).toBe(0)
    expect(store.ledger.ownedBytes).toBeGreaterThan(0)
  })
  it('releases when a stale install is refused only by its owner', () => {
    const store = small()
    const reservation = store.reserve('a', 3 * MiB)!
    expect(store.install('a', page('a', 1000), 'stale', reservation)).toBe(false)
    expect(store.ledger.reservedBytes).toBe(3 * MiB)
    reservation.release()
    expect(store.ledger.reservedBytes).toBe(0)
  })
})

describe('pinned snapshots', () => {
  it('charges an old snapshot a selection still holds', async () => {
    const store = small()
    store.install('a', page('a', 1_000_000), store.token('a'))
    const owned = store.ledger.ownedBytes
    const selecting = store.select('a', 'x')
    expect(store.ledger.pinnedBytes).toBe(0)
    store.clear('a')
    expect(store.ledger.pinnedBytes).toBe(owned)
    expect(store.reserve('b', 16 * MiB)).toBeNull()
    await selecting
    expect(store.ledger.pinnedBytes).toBe(0)
    expect(store.reserve('b', 16 * MiB)).not.toBeNull()
  })
  it('releases a pin when selection is cancelled', async () => {
    const store = small()
    store.install('a', page('a', 1000), store.token('a'))
    const abort = new AbortController()
    abort.abort()
    await expect(store.select('a', 'x', { signal: abort.signal })).rejects.toThrow()
    store.clear('a')
    expect(store.ledger.pinnedBytes).toBe(0)
  })
})

describe('hydration lifecycle', () => {
  let dir: string
  let db: ChatDatabase
  const settings = () => structuredClone(getDefaults())
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eris-reserve-'))
    contextMemoryStore.clear()
    contextMemoryStore.configure(settings().agent.contextMemory)
    db = new ChatDatabase(dir)
    vi.mocked(workspaceRequest).mockImplementation(
      async (request) =>
        (await handleWorkspaceRequest({ ...request, dir } as WorkspaceRequest)) as never
    )
    db.save({
      id: 't',
      title: 'History',
      model: 'local:test',
      createdAt: 1,
      updatedAt: 1,
      messages: [message('a', 'Remember: checkout')]
    })
  })
  afterEach(() => {
    closeChatDatabases()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it('holds no reservation after a normal load', async () => {
    await warmConversationMemory(null, 't', settings(), new AbortController().signal)
    expect(contextMemoryStore.has(memoryKey(null, 't'))).toBe(true)
    expect(contextMemoryStore.ledger.reservedBytes).toBe(0)
  })
  it('releases when the worker dies mid-load', async () => {
    const real = vi.mocked(workspaceRequest).getMockImplementation()!
    vi.mocked(workspaceRequest).mockImplementation(async (request) => {
      if (request.type === 'context-page') throw new Error('Worker exited')
      return real(request)
    })
    await expect(warmConversationMemory(null, 't', settings())).rejects.toThrow('Worker exited')
    expect(contextMemoryStore.ledger.reservedBytes).toBe(0)
  })
  it('holds a page charge until a late reply arrives after abort', async () => {
    const real = vi.mocked(workspaceRequest).getMockImplementation()!
    let reply = () => {}
    const arrived = new Promise<void>((resolve) => (reply = resolve))
    let requested = () => {}
    const asked = new Promise<void>((resolve) => (requested = resolve))
    vi.mocked(workspaceRequest).mockImplementation(async (request) => {
      if (request.type === 'context-page') {
        requested()
        await arrived
      }
      return real(request)
    })
    const abort = new AbortController()
    const load = warmConversationMemory(null, 't', settings(), abort.signal)
    await asked
    expect(contextMemoryStore.ledger.reservedBytes).toBeGreaterThan(0)
    abort.abort()
    await expect(load).rejects.toThrow()
    expect(contextMemoryStore.ledger.reservedBytes).toBeGreaterThan(0)
    reply()
    await vi.waitFor(() => expect(contextMemoryStore.ledger.reservedBytes).toBe(0))
    expect(contextMemoryStore.has(memoryKey(null, 't'))).toBe(false)
  })
  it('admits nothing when the envelope is taken', async () => {
    const held = contextMemoryStore.reserve('other', contextMemoryStore.ledger.envelopeBytes)
    await warmConversationMemory(null, 't', settings())
    expect(contextMemoryStore.has(memoryKey(null, 't'))).toBe(false)
    held!.release()
  })
})
