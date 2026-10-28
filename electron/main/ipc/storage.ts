import { ipcMain, dialog } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { appState } from '../app-state'
import { userDataRoot } from '../services/paths'
import {
  inspectEvidence,
  cleanupEvidence,
  backupEvidence,
  restoreEvidence,
  deleteThreadEvidence
} from '../services/evidence-lifecycle'
import {
  atomicEvidenceJson,
  readEvidence,
  evidenceBusy,
  storageFailure
} from '../services/evidence-records'
import { listChats, getChat, saveChat } from '../services/chats'
import type { ChatThread } from '../../../src/shared/settings-schema'
const ChatThreadSchema = z
  .object({
    id: z.string().min(1).max(256),
    title: z.string().max(10000),
    model: z.string().max(2048),
    messages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().max(1_000_000),
            createdAt: z.number().finite()
          })
          .passthrough()
      )
      .max(20000),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
  })
  .passthrough()
  .transform((value) => value as unknown as ChatThread)
const rootSchema = z.string().min(1).max(4096).nullable()
function owner(event: Electron.IpcMainInvokeEvent, root: unknown): string | null {
  const parsed = rootSchema.parse(root)
  if (
    !appState.mainWindow ||
    event.sender !== appState.mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error('Unauthorized storage request')
  if (parsed !== appState.currentWorkspace)
    throw new Error('Workspace changed before storage operation')
  return parsed
}
const policyPath = () => join(userDataRoot(), 'storage-policy.json')
const policy = () =>
  readEvidence(policyPath(), (value) =>
    z
      .object({ version: z.literal(1), enabled: z.boolean() })
      .strict()
      .parse(value)
  ) ?? { version: 1 as const, enabled: true }
let initialized = false
export function registerStorageIpc(): void {
  ipcMain.handle('storage:inspect', (event, root) => inspectEvidence(owner(event, root)))
  ipcMain.handle('storage:cleanup', (event, root) => {
    const parsed = owner(event, root)
    if (appState.chatStreamActive) throw new Error('Stop chat before cleanup')
    return cleanupEvidence(parsed)
  })
  ipcMain.handle('storage:policy', (event, root, enabled?: unknown) => {
    owner(event, root)
    if (enabled !== undefined)
      atomicEvidenceJson(policyPath(), { version: 1, enabled: z.boolean().parse(enabled) })
    return policy()
  })
  ipcMain.handle('storage:backup', async (event, root) => {
    const parsed = owner(event, root)
    if (appState.chatStreamActive || evidenceBusy())
      throw new Error('Stop active work before backup')
    const selected = await dialog.showSaveDialog({
      defaultPath: 'eris-private-evidence-backup.json'
    })
    if (selected.canceled || !selected.filePath) return null
    owner(event, parsed)
    const backup = backupEvidence(parsed)
    const threads = await listChats(parsed)
    if (threads.length > 200)
      throw new Error('More than 200 conversations; export selected conversations separately')
    const conversations = []
    for (const thread of threads) {
      const full = await getChat(parsed, thread.id)
      if (full) {
        if (
          (full.messageOffset ?? 0) > 0 ||
          (full.messageCount ?? full.messages.length) > full.messages.length
        )
          throw new Error('Conversation backup would be partial')
        conversations.push(full)
      }
    }
    owner(event, parsed)
    if (evidenceBusy()) throw new Error('A task started during backup; retry when idle')
    const body = JSON.stringify({ ...backup, conversations })
    if (Buffer.byteLength(body) > 32_000_000) throw new Error('Backup exceeds 32 MB')
    writeFileSync(selected.filePath, body, { mode: 0o600 })
    return selected.filePath
  })
  ipcMain.handle('storage:restore', async (event, root) => {
    const parsed = owner(event, root)
    if (appState.chatStreamActive || evidenceBusy())
      throw new Error('Stop active work before restore')
    const selected = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Eris private evidence backup', extensions: ['json'] }]
    })
    if (selected.canceled) return null
    owner(event, parsed)
    const path = selected.filePaths[0]!
    if (statSync(path).size > 32_000_000) throw new Error('Backup exceeds 32 MB')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const conversations = z
      .array(ChatThreadSchema)
      .max(200)
      .parse(raw.conversations ?? [])
    const result = restoreEvidence(parsed, raw)
    for (const thread of conversations) {
      owner(event, parsed)
      if (evidenceBusy()) throw new Error('A task started; remaining restore stopped')
      if (await getChat(parsed, thread.id)) result.conflicts.push('conversation:' + thread.id)
      else {
        await saveChat(parsed, thread)
        result.restored++
      }
    }
    return { restored: result.restored, conflicts: result.conflicts }
  })
  if (!initialized) {
    initialized = true
    const timer = setInterval(
      () => {
        if (policy().enabled && !evidenceBusy() && !appState.chatStreamActive) {
          try {
            cleanupEvidence(appState.currentWorkspace)
          } catch (error) {
            storageFailure(policyPath(), error)
          }
        }
      },
      30 * 60 * 1000
    )
    timer.unref()
  }
}
export function deleteConversationEvidence(root: string | null, id: string): void {
  if (appState.chatStreamActive) throw new Error('Stop chat before deleting recovery evidence')
  deleteThreadEvidence(root, id)
}
