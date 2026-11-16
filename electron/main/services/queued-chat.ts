import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_QUEUED_MESSAGES } from '../../../src/shared/chat-queue'
import { userDataRoot } from './paths'
import { parseChatSubmission, type ChatSubmission } from './chat-submission'

function queuePath(workspacePath: string | null, threadId: string): string {
  if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) throw new Error('Invalid queue thread.')
  const scope = createHash('sha256').update(JSON.stringify([workspacePath, threadId])).digest('hex')
  return join(userDataRoot(), 'queued-chats', scope + '.json')
}

export function readQueuedChat(workspacePath: string | null, threadId: string): ChatSubmission[] {
  const path = queuePath(workspacePath, threadId)
  try {
    if (statSync(path).size > MAX_QUEUED_MESSAGES * 2_000_000 + 128)
      throw new Error('Saved chat queue exceeds its storage limit.')
    const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(entries) || entries.length > MAX_QUEUED_MESSAGES)
      throw new Error('Invalid saved chat queue.')
    return entries.map((entry) => {
      const payload = parseChatSubmission(entry)
      if (payload.threadId !== threadId || payload.workspacePath !== workspacePath || !payload.prompt)
        throw new Error('A saved message has an invalid destination.')
      return payload
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function writeQueue(path: string, entries: ChatSubmission[]): void {
  if (!entries.length) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.' + randomUUID()
  try {
    writeFileSync(temp, JSON.stringify(entries), { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function persistQueuedChat(workspacePath: string | null, payload: ChatSubmission): void {
  if (!payload.threadId || payload.workspacePath !== workspacePath || !payload.prompt || payload.queueResume) {
    throw new Error('Queued messages require a chat destination.')
  }
  const entries = readQueuedChat(workspacePath, payload.threadId)
  if (entries.some((entry) => entry.requestId === payload.requestId))
    throw new Error('This message is already queued.')
  if (entries.length >= MAX_QUEUED_MESSAGES) throw new Error('This chat queue is full.')
  writeQueue(queuePath(workspacePath, payload.threadId), [...entries, payload])
}

export function removeQueuedChat(workspacePath: string | null, threadId: string, id?: string): void {
  const path = queuePath(workspacePath, threadId)
  if (id === undefined) {
    rmSync(path, { force: true })
    return
  }
  const entries = readQueuedChat(workspacePath, threadId)
  const remaining = entries.filter((entry) => entry.requestId !== id)
  if (remaining.length !== entries.length) writeQueue(path, remaining)
}
