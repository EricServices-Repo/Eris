import { contextMemoryStore } from '../services/context-memory-store'
import { memoryKey } from '../services/context-memory'
import { userChatsDir, workspaceChatsDir } from '../services/paths'
import { workspaceRequest } from '../services/workspace-worker-client'
import type { MemoryUsageStatus } from '../../../src/shared/memory-usage'
import { noteEvidenceChange } from '../services/context-evidence-epochs'
import { isPathInside } from '../services/workspace-fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { userDataRoot } from '../services/paths'
import type { ContextHeader } from '../../../src/shared/context-memory'
import { z } from 'zod'
import {
  inspectConversationMemory,
  warmConversationMemory,
  saveMemoryControls,
  invalidateConversationMemory
} from '../services/context-memory'
import { MemoryControlsSchema } from '../../../src/shared/context-memory'
import { getResolvedSettings } from '../services/settings'
import { deleteConversationEvidence } from './storage'
import { ipcMain } from 'electron'
import { deleteRule, listRules, saveRule } from '../services/rules'
import {
  listChats,
  getChat,
  createChat,
  saveChat,
  deleteChat,
  loadWorkspaceRules,
  appendChatMessage
} from '../services/chats'
import {
  createSkill,
  deleteSkill,
  ensureSkillsDirs,
  getSkill,
  listSkills,
  loadSkillsPrompt,
  updateSkill
} from '../services/skills'
import { logInfo } from '../services/logger'
import type {
  ChatThread,
  ChatMessage,
  SkillInput,
  SkillScope
} from '../../../src/shared/settings-schema'
import { appState } from '../app-state'
import { getWorkspaceByPath } from '../services/workspace'

function chatWorkspace(requested: string | null | undefined): string | null {
  if (requested === undefined) return appState.currentWorkspace
  if (requested === null) return null
  const workspace = getWorkspaceByPath(requested)
  if (!workspace) throw new Error('Chat workspace is no longer available')
  return workspace.path
}

export function registerChatsIpc(): void {
  ipcMain.handle('contextMemory:usage', async (event, raw: unknown): Promise<MemoryUsageStatus> => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized memory usage request')
    const { activeThreadId } = z
      .object({ activeThreadId: z.string().min(1).max(256).nullable().optional() })
      .strict()
      .parse(raw)
    const root = appState.currentWorkspace
    const epoch = appState.workspaceEpoch
    let archive: MemoryUsageStatus['archive'] = null
    let archiveError: string | null = null
    try {
      archive = await workspaceRequest({
        type: 'chat-storage-usage',
        dir: root ? workspaceChatsDir(root) : userChatsDir()
      })
    } catch {
      archiveError = 'Saved history usage is temporarily unavailable.'
    }
    if (epoch !== appState.workspaceEpoch || root !== appState.currentWorkspace)
      throw new Error('Workspace changed; refresh memory usage')
    const profile = getResolvedSettings(null).agent
    const { rss, heapUsed } = process.memoryUsage()
    return {
      at: Date.now(),
      scope: root ? 'workspace' : 'profile',
      config: profile.contextMemory,
      projectMemory: profile.projectMemory,
      effectivePolicy: getResolvedSettings(root).agent.contextMemory,
      cache: contextMemoryStore.usage(activeThreadId ? memoryKey(root, activeThreadId) : undefined),
      process: { rss, heapUsed },
      archive,
      archiveError
    }
  })
  ipcMain.on('contextMemory:documentChanged', (event, path: unknown, dirty: unknown) => {
    const root = appState.currentWorkspace
    if (
      !root ||
      event.sender !== appState.mainWindow?.webContents ||
      event.senderFrame !== appState.mainWindow.webContents.mainFrame ||
      typeof path !== 'string' ||
      path.length > 4096 ||
      typeof dirty !== 'boolean'
    )
      return
    const abs = resolve(root, path)
    if (isPathInside(root, abs)) noteEvidenceChange(root, abs, dirty)
  })
  const inspections = new Map<
    string,
    {
      root: string | null
      workspaceId: string | null
      epoch: number
      profile: string
      threadId: string
      source: ContextHeader
      controlsRevision: number
      sender: unknown
      expires: number
    }
  >()
  ipcMain.handle('contextMemory:inspect', async (event, raw: unknown) => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('Unauthorized context inspection')
    const { id, query, controls, evict, workspacePath, snapshotHandle, model } = z
      .object({
        workspacePath: z.string().max(4096).nullable().optional(),
        snapshotHandle: z.string().uuid().optional(),
        id: z.string().min(1).max(256),
        query: z.string().max(4000).default(''),
        model: z.string().max(256).optional(),
        controls: MemoryControlsSchema.optional(),
        evict: z.boolean().optional()
      })
      .strict()
      .parse(raw)
    const root = appState.currentWorkspace
    const epoch = appState.workspaceEpoch
    const workspaceId = root ? getWorkspaceByPath(root)?.id : null
    const profile = userDataRoot()
    const stale = () =>
      new Error(
        'STALE_CONTEXT_INSPECTION: Workspace or conversation changed. Reopen conversation memory.'
      )
    const eligible = () =>
      appState.currentWorkspace === root &&
      appState.workspaceEpoch === epoch &&
      userDataRoot() === profile &&
      (!root || getWorkspaceByPath(root)?.id === workspaceId)
    if ((root && !workspaceId) || (workspacePath !== undefined && workspacePath !== root))
      throw stale()
    const lease = snapshotHandle ? inspections.get(snapshotHandle) : undefined
    if ((controls || evict) && !lease) throw stale()
    if (
      snapshotHandle &&
      (!lease ||
        lease.root !== root ||
        lease.workspaceId !== workspaceId ||
        lease.epoch !== epoch ||
        lease.profile !== profile ||
        lease.threadId !== id ||
        lease.sender !== event.sender ||
        lease.expires < Date.now())
    )
      throw stale()
    const thread = await getChat(root, id, { limit: 1 })
    if (!thread) throw new Error('Chat not found')
    if (!eligible()) throw stale()
    const source: ContextHeader = {
      revision: thread.contextRevision ?? 0,
      messageCount: thread.messageCount ?? thread.messages.length,
      sourceEpoch: thread.contextEpoch ?? ''
    }
    if (
      lease &&
      (lease.source.revision !== source.revision ||
        lease.source.messageCount !== source.messageCount ||
        lease.source.sourceEpoch !== source.sourceEpoch)
    )
      throw stale()
    if (controls) {
      if ((controls.revision ?? 0) !== lease!.controlsRevision) throw stale()
      await saveMemoryControls(root, id, controls, lease!.source)
    }
    if (!eligible()) throw stale()
    if (evict) invalidateConversationMemory(root, id)
    const inspection = await inspectConversationMemory(
      root,
      id,
      query,
      getResolvedSettings(root),
      model
    )
    if (!eligible()) throw stale()
    for (const [handle, value] of inspections)
      if (value.expires < Date.now()) inspections.delete(handle)
    if (inspections.size >= 128) inspections.delete(inspections.keys().next().value!)
    const handle = randomUUID()
    inspections.set(handle, {
      root,
      workspaceId: workspaceId ?? null,
      epoch,
      profile,
      threadId: id,
      source,
      controlsRevision: inspection.controls.revision ?? 0,
      sender: event.sender,
      expires: Date.now() + 10 * 60000
    })
    if (snapshotHandle) inspections.delete(snapshotHandle)
    return { ...inspection, snapshotHandle: handle }
  })
  ipcMain.handle('chats:list', () => listChats(appState.currentWorkspace))
  ipcMain.handle(
    'chats:get',
    async (_e, id: string, page?: { before?: number; limit?: number }) => {
      const root = appState.currentWorkspace
      const chat = await getChat(root, id, { limit: 60, ...page })
      if (chat && page?.before === undefined)
        void warmConversationMemory(root, id, getResolvedSettings(root)).catch(() => undefined)
      return chat
    }
  )
  ipcMain.handle('chats:create', async (_e, model: string) => {
    const thread = await createChat(appState.currentWorkspace, model)
    logInfo('Chat created', { id: thread.id, model })
    return thread
  })
  ipcMain.handle('chats:save', (_e, thread: ChatThread) =>
    saveChat(appState.currentWorkspace, thread)
  )
  ipcMain.handle(
    'chats:append',
    (_e, id: string, message: ChatMessage, model?: string, workspacePath?: string | null) =>
      appendChatMessage(chatWorkspace(workspacePath), id, message, model)
  )
  ipcMain.handle('chats:delete', async (event, id: string) => {
    if (
      !appState.mainWindow ||
      event.sender !== appState.mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof id !== 'string' ||
      id.length > 256
    )
      throw new Error('Invalid conversation deletion')
    const root = appState.currentWorkspace
    deleteConversationEvidence(root, id)
    await deleteChat(root, id)
    logInfo('Chat deleted', { id })
    return true
  })
  ipcMain.handle('chats:rules', () => loadWorkspaceRules(appState.currentWorkspace))

  ipcMain.handle('skills:list', () => {
    ensureSkillsDirs(appState.currentWorkspace)
    return listSkills(appState.currentWorkspace)
  })
  ipcMain.handle('skills:get', (_e, id: string, scope?: SkillScope) =>
    getSkill(appState.currentWorkspace, id, scope)
  )
  ipcMain.handle('skills:create', (_e, input: SkillInput) => {
    ensureSkillsDirs(appState.currentWorkspace)
    const skill = createSkill(appState.currentWorkspace, input)
    logInfo('Skill created', { id: skill.id, scope: skill.scope })
    return skill
  })
  ipcMain.handle(
    'skills:update',
    (
      _e,
      id: string,
      scope: SkillScope,
      patch: Partial<Pick<SkillInput, 'name' | 'description' | 'body'>>
    ) => {
      const skill = updateSkill(appState.currentWorkspace, id, scope, patch)
      logInfo('Skill updated', { id: skill.id, scope: skill.scope })
      return skill
    }
  )
  ipcMain.handle('skills:delete', (_e, id: string, scope: SkillScope) => {
    const ok = deleteSkill(appState.currentWorkspace, id, scope)
    if (ok) logInfo('Skill deleted', { id, scope })
    return ok
  })
  ipcMain.handle('skills:prompt', (_e, ids: string[]) =>
    loadSkillsPrompt(appState.currentWorkspace, ids)
  )

  ipcMain.handle('rules:list', () => listRules(appState.currentWorkspace))
  ipcMain.handle('rules:save', (_e, name: string, body: string, previousId?: string) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit rules')
    return saveRule(appState.currentWorkspace, name, body, previousId)
  })
  ipcMain.handle('rules:delete', (_e, id: string) => {
    if (!appState.currentWorkspace) throw new Error('Open a workspace to edit rules')
    return deleteRule(appState.currentWorkspace, id)
  })
}
