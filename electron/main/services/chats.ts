import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { ChatThread, ChatMessage } from '../../../src/shared/settings-schema'
import { userChatsDir, workspaceChatsDir, workspaceRulesDir } from './paths'
import { workspaceRequest } from './workspace-worker-client'
import { invalidateConversationMemory, updateConversationMemory } from './context-memory'
import type { ChatPage } from './workspace-worker-protocol'

function chatsDir(workspacePath: string | null): string {
  return workspacePath ? workspaceChatsDir(workspacePath) : userChatsDir()
}

export function listChats(workspacePath: string | null): Promise<ChatThread[]> {
  return workspaceRequest({ type: 'chat-list', dir: chatsDir(workspacePath) })
}

export function getChat(
  workspacePath: string | null,
  id: string,
  page?: ChatPage
): Promise<ChatThread | null> {
  return workspaceRequest({ type: 'chat-get', dir: chatsDir(workspacePath), id, page })
}

export function createChat(workspacePath: string | null, model: string): Promise<ChatThread> {
  const now = Date.now()
  const thread: ChatThread = {
    id: randomUUID(),
    title: 'New chat',
    model,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
  return saveChat(workspacePath, thread)
}

export function saveChat(workspacePath: string | null, thread: ChatThread): Promise<ChatThread> {
  invalidateConversationMemory(workspacePath, thread.id)
  return workspaceRequest({ type: 'chat-save', dir: chatsDir(workspacePath), thread }).finally(() =>
    invalidateConversationMemory(workspacePath, thread.id)
  )
}

export function deleteChat(workspacePath: string | null, id: string): Promise<boolean> {
  invalidateConversationMemory(workspacePath, id)
  return workspaceRequest({ type: 'chat-delete', dir: chatsDir(workspacePath), id }).finally(() =>
    invalidateConversationMemory(workspacePath, id)
  )
}

export function appendChatMessage(
  workspacePath: string | null,
  id: string,
  message: ChatMessage,
  model?: string
): Promise<ChatThread> {
  return workspaceRequest({
    type: 'chat-append',
    dir: chatsDir(workspacePath),
    id,
    message,
    model
  }).then((thread) => {
    updateConversationMemory(workspacePath, thread)
    return thread
  })
}

export async function appendMessage(
  workspacePath: string | null,
  chatId: string,
  role: ChatMessage['role'],
  content: string
): Promise<ChatThread> {
  return appendChatMessage(workspacePath, chatId, {
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now()
  })
}

const workspaceRulesCache = new Map<string, { fingerprint: string; value: string }>()

export function invalidateWorkspaceRulesCache(workspacePath: string | null): void {
  if (!workspacePath) {
    workspaceRulesCache.clear()
    return
  }
  workspaceRulesCache.delete(resolve(workspacePath))
}

export function loadWorkspaceRules(workspacePath: string | null): string {
  if (!workspacePath) return ''
  const dir = workspaceRulesDir(workspacePath)
  if (!existsSync(dir)) {
    invalidateWorkspaceRulesCache(workspacePath)
    return ''
  }
  const key = resolve(workspacePath)
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .flatMap((name) => {
      try {
        const path = join(dir, name)
        const st = statSync(path)
        return [{ name, path, mtimeMs: st.mtimeMs, size: st.size }]
      } catch {
        return []
      }
    })
  const fingerprint = files.map((file) => `${file.name}:${file.mtimeMs}:${file.size}`).join('\0')
  const cached = workspaceRulesCache.get(key)
  if (cached?.fingerprint === fingerprint) return cached.value
  const parts: string[] = []
  for (const file of files) {
    try {
      parts.push(`# Rule: ${file.name}\n${readFileSync(file.path, 'utf8')}`)
    } catch {
      // skip
    }
  }
  const value = parts.join('\n\n')
  workspaceRulesCache.set(key, { fingerprint, value })
  if (workspaceRulesCache.size > 80) {
    const oldestKey = workspaceRulesCache.keys().next().value
    if (oldestKey) workspaceRulesCache.delete(oldestKey)
  }
  return value
}

/** Main-owned task resolution records source scope without changing the user's text. */
export async function scopeChatSource(
  root: string | null,
  id: string,
  messageId: string,
  projectRoot: string | null
) {
  const changed = await workspaceRequest({
    type: 'context-source-scope',
    dir: chatsDir(root),
    id,
    messageId,
    projectRoot
  })
  if (changed) invalidateConversationMemory(root, id)
}
