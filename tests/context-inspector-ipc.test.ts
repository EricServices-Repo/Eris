import { workspaceRequest } from '../electron/main/services/workspace-worker-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextMemorySettingsSchema,
  emptyMemoryControls,
  type MemoryControls
} from '../src/shared/context-memory'
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  notifications: new Map<string, (event: unknown, path: unknown, dirty: unknown) => void>(),
  controls: {} as MemoryControls,
  revision: 1,
  sourceEpoch: 'source-A',
  workspaceId: 'registered-A'
}))
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  ipcMain: {
    on: (name: string, handler: (event: unknown, path: unknown, dirty: unknown) => void) =>
      h.notifications.set(name, handler),
    handle: (name: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) =>
      h.handlers.set(name, handler)
  }
}))
vi.mock('../electron/main/services/chats', () => ({
  getChat: vi.fn(async () => ({
    id: 'same',
    messages: [],
    messageCount: 1,
    contextRevision: h.revision,
    contextEpoch: h.sourceEpoch
  }))
}))
vi.mock('../electron/main/services/workspace', () => ({
  getWorkspaceByPath: (path: string) => ({
    path,
    id: path === '/A' ? h.workspaceId : 'registered-B'
  })
}))
vi.mock('../electron/main/services/workspace-worker-client', () => ({ workspaceRequest: vi.fn() }))
vi.mock('../electron/main/services/settings', () => ({
  getResolvedSettings: () => ({
    agent: { contextMemory: ContextMemorySettingsSchema.parse({}), projectMemory: 'ask' }
  })
}))
vi.mock('../electron/main/services/context-memory', () => ({
  memoryKey: (root: string | null, id: string) => `${root}:${id}`,
  warmConversationMemory: vi.fn(),
  invalidateConversationMemory: vi.fn(),
  saveMemoryControls: vi.fn(async (_root: string, _id: string, controls: MemoryControls) => {
    h.controls = { ...controls, revision: (controls.revision ?? 0) + 1 }
    return h.controls
  }),
  inspectConversationMemory: vi.fn(async () => ({
    controls: h.controls,
    controlsAvailable: true,
    facts: [],
    manifest: {},
    processLogicalBytes: 0
  }))
}))
import { evidenceEpoch } from '../electron/main/services/context-evidence-epochs'
import { appState } from '../electron/main/app-state'
import { registerChatsIpc } from '../electron/main/ipc/chats'
import { getChat } from '../electron/main/services/chats'
import { saveMemoryControls } from '../electron/main/services/context-memory'
const sender = { mainFrame: {} }
const event = { sender, senderFrame: sender.mainFrame }
const invoke = (raw: unknown, source: unknown = event) =>
  h.handlers.get('contextMemory:inspect')!(source, raw) as Promise<{
    snapshotHandle: string
    controls: MemoryControls
  }>
beforeEach(() => {
  vi.clearAllMocks()
  h.controls = emptyMemoryControls()
  h.revision = 1
  h.sourceEpoch = 'source-A'
  h.workspaceId = 'registered-A'
  appState.currentWorkspace = '/A'
  appState.mainWindow = { webContents: sender } as never
  registerChatsIpc()
})
describe('RAM-CTX-009 inspector snapshot binding', () => {
  it('requires a lease and returns a new lease after a correctly scoped update', async () => {
    await expect(invoke({ id: 'same', controls: h.controls })).rejects.toThrow(
      'STALE_CONTEXT_INSPECTION'
    )
    const snapshot = await invoke({ id: 'same', workspacePath: '/A' })
    const updated = await invoke({
      id: 'same',
      workspacePath: '/A',
      snapshotHandle: snapshot.snapshotHandle,
      controls: { ...snapshot.controls, pinned: [{ id: 'p', text: 'Use CAD' }] }
    })
    expect(updated.snapshotHandle).not.toBe(snapshot.snapshotHandle)
    expect(saveMemoryControls).toHaveBeenCalledWith('/A', 'same', expect.anything(), {
      revision: 1,
      messageCount: 1,
      sourceEpoch: 'source-A'
    })
    await expect(
      invoke({ id: 'same', snapshotHandle: snapshot.snapshotHandle, controls: h.controls })
    ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
  })
  it('rejects an A action after switching to copied-thread workspace B, or away and back', async () => {
    const snapshot = await invoke({ id: 'same', workspacePath: '/A' })
    appState.currentWorkspace = '/B'
    await expect(
      invoke({
        id: 'same',
        workspacePath: '/A',
        snapshotHandle: snapshot.snapshotHandle,
        controls: h.controls
      })
    ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
    appState.currentWorkspace = '/A'
    await expect(
      invoke({ id: 'same', snapshotHandle: snapshot.snapshotHandle, controls: h.controls })
    ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
    expect(saveMemoryControls).not.toHaveBeenCalled()
  })
  it.each(['revision', 'sourceEpoch', 'workspaceId'] as const)(
    'rejects changed %s before any write',
    async (field) => {
      const snapshot = await invoke({ id: 'same' })
      if (field === 'revision') h.revision++
      else h[field] = 'replacement'
      await expect(
        invoke({ id: 'same', snapshotHandle: snapshot.snapshotHandle, controls: h.controls })
      ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
      expect(saveMemoryControls).not.toHaveBeenCalled()
    }
  )
  it('rejects a delayed initial read after the active workspace changes', async () => {
    let release!: () => void
    vi.mocked(getChat).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        id: 'same',
        messages: [],
        messageCount: 1,
        contextRevision: 1,
        contextEpoch: 'source-A'
      } as never
    })
    const read = invoke({ id: 'same', workspacePath: '/A' })
    appState.currentWorkspace = '/B'
    release()
    await expect(read).rejects.toThrow('STALE_CONTEXT_INSPECTION')
  })
  it('enforces main-frame ownership and the inspected controls revision', async () => {
    await expect(invoke({ id: 'same' }, { ...event, senderFrame: {} })).rejects.toThrow(
      'Unauthorized'
    )
    const snapshot = await invoke({ id: 'same' })
    await expect(
      invoke({
        id: 'same',
        snapshotHandle: snapshot.snapshotHandle,
        controls: { ...h.controls, revision: 5 }
      })
    ).rejects.toThrow('STALE_CONTEXT_INSPECTION')
    expect(saveMemoryControls).not.toHaveBeenCalled()
  })
})

it('accepts document invalidation only from the current main frame and workspace', () => {
  const notify = h.notifications.get('contextMemory:documentChanged')!
  const before = evidenceEpoch('/A', ['app.ts'])
  notify({ sender: {}, senderFrame: {} }, '/A/app.ts', true)
  notify({ sender, senderFrame: {} }, '/A/app.ts', true)
  notify(event, '/B/app.ts', true)
  expect(evidenceEpoch('/A', ['app.ts'])).toEqual(before)
  notify(event, '/A/app.ts', true)
  expect(evidenceEpoch('/A', ['app.ts']).dirty).toBe(true)
})

describe('Read-only memory usage IPC', () => {
  const read = (raw: unknown = {}, source: unknown = event) =>
    h.handlers.get('contextMemory:usage')!(source, raw) as Promise<
      import('../src/shared/memory-usage').MemoryUsageStatus
    >
  it('restricts sender, frame and input before reading history', async () => {
    await expect(read({}, { sender: {}, senderFrame: {} })).rejects.toThrow('Unauthorized')
    await expect(read({}, { ...event, senderFrame: {} })).rejects.toThrow('Unauthorized')
    await expect(read({ workspacePath: '/untrusted' })).rejects.toThrow()
    await expect(read({ activeThreadId: '' })).rejects.toThrow()
    expect(workspaceRequest).not.toHaveBeenCalled()
  })
  it('returns metadata without requesting transcript pages or warming memory', async () => {
    vi.mocked(workspaceRequest).mockResolvedValueOnce({
      initialized: true,
      conversations: 2,
      messages: 3,
      databaseBytes: 4096,
      journalBytes: 20
    } as never)
    const result = await read({ activeThreadId: 'same' })
    expect(result.scope).toBe('workspace')
    expect(result.archive?.messages).toBe(3)
    expect(result.process.rss).toBeGreaterThan(0)
    expect(result.cache.activeBytes).toBe(0)
    expect(workspaceRequest).toHaveBeenCalledTimes(1)
    expect(workspaceRequest).toHaveBeenCalledWith({
      type: 'chat-storage-usage',
      dir: expect.any(String)
    })
    expect(getChat).not.toHaveBeenCalled()
  })
  it('reports archive failures independently from RAM counters', async () => {
    vi.mocked(workspaceRequest).mockRejectedValueOnce(new Error('private filesystem detail'))
    const result = await read()
    expect(result.archive).toBeNull()
    expect(result.archiveError).toBe('Saved history usage is temporarily unavailable.')
    expect(result.cache.warmConversations).toBe(0)
    expect(result.archiveError).not.toContain('private')
  })
  it('rejects telemetry read against a workspace switched during the worker request', async () => {
    let release!: () => void
    vi.mocked(workspaceRequest).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {} as never
    })
    const pending = read()
    appState.currentWorkspace = '/B'
    release()
    await expect(pending).rejects.toThrow('Workspace changed')
  })
})
