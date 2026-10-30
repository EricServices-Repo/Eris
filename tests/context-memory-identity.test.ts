import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('worker_threads', async () => ({
  ...(await vi.importActual<typeof import('worker_threads')>('worker_threads')),
  parentPort: null
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { handleWorkspaceRequest } from '../electron/main/workspace-worker'
import {
  ChatDatabase,
  chatDatabase,
  closeChatDatabases
} from '../electron/main/services/chat-database'
import {
  conversationContext,
  memoryKey,
  saveMemoryControls
} from '../electron/main/services/context-memory'
import { contextMemoryStore } from '../electron/main/services/context-memory-store'
import { getDefaults } from '../electron/main/services/settings'
import {
  registeredWorkspaceId,
  rememberWorkspace,
  removeWorkspace,
  setAppState
} from '../electron/main/services/workspace'
import { workspaceChatsDir } from '../electron/main/services/paths'
import { emptyMemoryControls } from '../src/shared/context-memory'
import type { WorkspaceRequest } from '../electron/main/services/workspace-worker-protocol'

let parent: string, root: string, chats: string
const settings = () => {
  const value = structuredClone(getDefaults())
  value.agent.contextMemory.foregroundDeadlineMs = 2000
  return value
}
const thread = (text: string) => ({
  id: 'copied-thread',
  title: 'History',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'same-id', role: 'user' as const, content: text, createdAt: 1 }]
})
const recall = (query = 'checkout') => conversationContext(root, 'copied-thread', query, settings())

beforeEach(() => {
  contextMemoryStore.clear()
  contextMemoryStore.configure(settings().agent.contextMemory)
  setAppState({ workspaces: [], lastWorkspaceId: null })
  parent = mkdtempSync(join(tmpdir(), 'eris-identity-'))
  root = join(parent, 'project')
  rememberWorkspace(root)
  chats = workspaceChatsDir(root)
  vi.mocked(workspaceRequest).mockImplementation(
    async (req) => (await handleWorkspaceRequest(req as WorkspaceRequest)) as never
  )
})
afterEach(() => {
  closeChatDatabases()
  rmSync(parent, { recursive: true, force: true })
})

describe('memory namespace registration', () => {
  it('gives a new registration at a reused path a new namespace', () => {
    const first = memoryKey(root, 'copied-thread')
    const id = registeredWorkspaceId(root)!
    removeWorkspace(id)
    expect(registeredWorkspaceId(root)).toBeNull()
    expect(memoryKey(root, 'copied-thread')).not.toBe(first)
    rememberWorkspace(root)
    expect(registeredWorkspaceId(root)).not.toBe(id)
    expect(memoryKey(root, 'copied-thread')).not.toBe(first)
  })
  it('keeps symlink aliases of a folder in one namespace', () => {
    const alias = join(parent, 'alias')
    symlinkSync(root, alias)
    expect(memoryKey(alias, 't')).toBe(memoryKey(root, 't'))
    rememberWorkspace(alias)
    expect(registeredWorkspaceId(alias)).toBe(registeredWorkspaceId(root))
    expect(memoryKey(alias, 't')).toBe(memoryKey(root, 't'))
  })
  it('ignores a registration asserted by copied workspace metadata', () => {
    const before = memoryKey(root, 't')
    writeFileSync(join(root, '.eris', 'workspace.json'), JSON.stringify({ id: 'attacker-chosen' }))
    expect(registeredWorkspaceId(root)).not.toBe('attacker-chosen')
    expect(memoryKey(root, 't')).toBe(before)
  })
  it('separates profiles at one workspace path', () => {
    const before = memoryKey(root, 't')
    const previous = process.env.ERIS_TEST_APPDATA
    const other = join(parent, 'other-profile')
    mkdirSync(other)
    process.env.ERIS_TEST_APPDATA = other
    try {
      expect(memoryKey(root, 't')).not.toBe(before)
    } finally {
      process.env.ERIS_TEST_APPDATA = previous
    }
  })
  it('does not recover cached text through a re-registered path', async () => {
    chatDatabase(chats).save(thread('Remember: checkout uses PRIVATE-A'))
    expect((await recall()).prompt.text).toContain('PRIVATE-A')
    removeWorkspace(registeredWorkspaceId(root)!)
    rememberWorkspace(root)
    expect(contextMemoryStore.has(memoryKey(root, 'copied-thread'))).toBe(false)
  })
})

describe('database incarnation', () => {
  /** Stage a copy that shares thread ID, stored epoch and revision, then swap it in. */
  function replaceWithDivergedCopy(text: string) {
    closeChatDatabases()
    const copy = join(parent, 'copy')
    mkdirSync(copy)
    copyFileSync(join(chats, 'chats.sqlite'), join(copy, 'chats.sqlite'))
    const database = new ChatDatabase(copy)
    database.save(thread(text))
    database.close()
    rmSync(join(chats, 'chats.sqlite'))
    renameSync(join(copy, 'chats.sqlite'), join(chats, 'chats.sqlite'))
  }
  it('rejects warm text when a copied thread replaces the database', async () => {
    chatDatabase(chats).save(thread('Remember: checkout uses PRIVATE-A'))
    expect((await recall()).prompt.text).toContain('PRIVATE-A')
    expect(contextMemoryStore.has(memoryKey(root, 'copied-thread'))).toBe(true)
    replaceWithDivergedCopy('Remember: checkout uses REPLACEMENT-B')
    const after = await recall()
    expect(after.prompt.text).toContain('REPLACEMENT-B')
    expect(after.prompt.text).not.toContain('PRIVATE-A')
  })
  it('reopens a replaced file instead of serving the old handle', () => {
    const first = chatDatabase(chats)
    first.save(thread('Original text'))
    const replacement = join(parent, 'replacement')
    const fresh = new ChatDatabase(replacement)
    fresh.save(thread('Replacement text'))
    fresh.close()
    rmSync(join(chats, 'chats.sqlite'))
    renameSync(join(replacement, 'chats.sqlite'), join(chats, 'chats.sqlite'))
    expect(first.replaced()).toBe(true)
    const reopened = chatDatabase(chats)
    expect(reopened).not.toBe(first)
    expect(reopened.get('copied-thread')?.messages[0]?.content).toBe('Replacement text')
  })
  it('keeps a journal delivered with the replacement database', () => {
    const first = new ChatDatabase(chats)
    first.save(thread('Original text'))
    const delivered = Buffer.from('delivered journal')
    rmSync(join(chats, 'chats.sqlite'))
    rmSync(join(chats, 'chats.sqlite-wal'))
    writeFileSync(join(chats, 'chats.sqlite-wal'), delivered)
    const replacement = join(parent, 'replacement')
    const fresh = new ChatDatabase(replacement)
    fresh.close()
    renameSync(join(replacement, 'chats.sqlite'), join(chats, 'chats.sqlite'))
    first.retire()
    expect(existsSync(join(chats, 'chats.sqlite-wal'))).toBe(true)
    expect(readFileSync(join(chats, 'chats.sqlite-wal'))).toEqual(delivered)
  })
  it('keeps source epochs stable across ordinary reopen and writes', () => {
    const first = chatDatabase(chats)
    first.save(thread('Stable text'))
    const before = first.contextHeader('copied-thread')!.sourceEpoch
    closeChatDatabases()
    expect(chatDatabase(chats).contextHeader('copied-thread')!.sourceEpoch).toBe(before)
    expect(chatDatabase(chats)).toBe(chatDatabase(chats))
  })
  it('refuses control edits bound to the replaced database', async () => {
    chatDatabase(chats).save(thread('Remember: checkout uses PRIVATE-A'))
    const stale = chatDatabase(chats).contextHeader('copied-thread')!
    replaceWithDivergedCopy('Remember: checkout uses REPLACEMENT-B')
    await expect(
      saveMemoryControls(root, 'copied-thread', emptyMemoryControls(), stale)
    ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
    const controls = chatDatabase(chats).contextControls('copied-thread')
    expect(controls.forgotten).toEqual([])
  })
})
