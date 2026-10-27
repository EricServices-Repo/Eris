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
  ipcMain.handle('chats:list', () => listChats(appState.currentWorkspace))
  ipcMain.handle('chats:get', (_e, id: string, page?: { before?: number; limit?: number }) =>
    getChat(appState.currentWorkspace, id, { limit: 60, ...page })
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
