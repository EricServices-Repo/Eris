import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ChatThread, ChatMessage } from '../../../src/shared/settings-schema'
import { userChatsDir, workspaceChatsDir, workspaceRulesDir } from './paths'

function chatsDir(workspacePath: string | null): string {
  return workspacePath ? workspaceChatsDir(workspacePath) : userChatsDir()
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function threadPath(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

export function listChats(workspacePath: string | null): ChatThread[] {
  const dir = chatsDir(workspacePath)
  if (!existsSync(dir)) return []
  const threads: ChatThread[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ChatThread
      threads.push(raw)
    } catch {
      // skip
    }
  }
  return threads.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getChat(workspacePath: string | null, id: string): ChatThread | null {
  const path = threadPath(chatsDir(workspacePath), id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ChatThread
  } catch {
    return null
  }
}

export function createChat(workspacePath: string | null, model: string): ChatThread {
  const dir = chatsDir(workspacePath)
  ensureDir(dir)
  const now = Date.now()
  const thread: ChatThread = {
    id: randomUUID(),
    title: 'New chat',
    model,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
  writeFileSync(threadPath(dir, thread.id), JSON.stringify(thread, null, 2), 'utf8')
  return thread
}

export function saveChat(workspacePath: string | null, thread: ChatThread): ChatThread {
  const dir = chatsDir(workspacePath)
  ensureDir(dir)
  const next = { ...thread, updatedAt: Date.now() }
  if (!next.title || next.title === 'New chat') {
    const firstUser = next.messages.find((m) => m.role === 'user')
    if (firstUser) {
      next.title = firstUser.content.slice(0, 48).replace(/\s+/g, ' ')
    }
  }
  writeFileSync(threadPath(dir, next.id), JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function deleteChat(workspacePath: string | null, id: string): void {
  const path = threadPath(chatsDir(workspacePath), id)
  if (existsSync(path)) unlinkSync(path)
}

export function appendMessage(
  workspacePath: string | null,
  chatId: string,
  role: ChatMessage['role'],
  content: string
): ChatThread {
  const thread = getChat(workspacePath, chatId)
  if (!thread) throw new Error('Chat not found')
  thread.messages.push({
    id: randomUUID(),
    role,
    content,
    createdAt: Date.now()
  })
  return saveChat(workspacePath, thread)
}

export function loadWorkspaceRules(workspacePath: string | null): string {
  if (!workspacePath) return ''
  const dir = workspaceRulesDir(workspacePath)
  if (!existsSync(dir)) return ''
  const parts: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    try {
      parts.push(`# Rule: ${name}\n${readFileSync(join(dir, name), 'utf8')}`)
    } catch {
      // skip
    }
  }
  return parts.join('\n\n')
}
