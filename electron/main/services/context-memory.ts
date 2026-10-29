import { createHash } from 'crypto'
import { userDataRoot, userChatsDir, workspaceChatsDir } from './paths'
import { realpathAllowMissing } from './workspace-fs'
import { workspaceRequest } from './workspace-worker-client'
import { contextMemoryStore } from './context-memory-store'
import type { AppSettings, ChatThread } from '../../../src/shared/settings-schema'
import {
  ContextMemorySettingsSchema,
  type MemoryControls
} from '../../../src/shared/context-memory'
const pending = new Map<string, Promise<void>>()
const idleSweep = setInterval(() => contextMemoryStore.sweep(), 60000)
idleSweep.unref()
export const memoryKey = (root: string | null, thread: string) =>
  createHash('sha256')
    .update(JSON.stringify([userDataRoot(), root ? realpathAllowMissing(root) : null, thread]))
    .digest('hex')
const dir = (root: string | null) => (root ? workspaceChatsDir(root) : userChatsDir())
export function invalidateConversationMemory(root: string | null, id: string) {
  contextMemoryStore.clear(memoryKey(root, id))
}
export function updateConversationMemory(root: string | null, thread: ChatThread) {
  contextMemoryStore.append(
    memoryKey(root, thread.id),
    thread.contextRevision ?? 0,
    thread.messageCount ?? thread.messages.length,
    thread.messages,
    thread.messageOffset ?? 0
  )
}
export async function warmConversationMemory(
  root: string | null,
  id: string,
  settings: AppSettings,
  signal?: AbortSignal
) {
  contextMemoryStore.configure(
    settings.agent.contextMemory ?? ContextMemorySettingsSchema.parse({})
  )
  const key = memoryKey(root, id)
  if (!contextMemoryStore.config.enabled || contextMemoryStore.has(key)) return
  const existing = pending.get(key)
  if (existing) {
    await existing
    return
  }
  if (pending.size >= 2) return
  const token = contextMemoryStore.token(key),
    config = { ...contextMemoryStore.config }
  const run = (async () => {
    const controls = await workspaceRequest({ type: 'context-controls', dir: dir(root), id })
    let before: number | undefined,
      revision: number | undefined,
      total = 0,
      bytes = 0,
      partial = false
    const records: Array<{ ordinal: number; message: ChatThread['messages'][number] }> = []
    for (let pages = 0; pages < Math.ceil(config.maxMessages / 500) + 1; pages++) {
      signal?.throwIfAborted()
      if (token !== contextMemoryStore.token(key)) return
      const page = await workspaceRequest({ type: 'context-page', dir: dir(root), id, before })
      if (!page) return
      if (revision !== undefined && revision !== page.revision) return // concurrent transcript mutation; next request retries, never publish a mixed snapshot
      revision = page.revision
      total = page.messageCount
      before = page.before
      partial ||= page.omitted > 0
      records.unshift(...page.records)
      bytes += page.records.reduce(
        (n, r) => n + Buffer.byteLength(JSON.stringify(r.message)) * 4 + 512,
        0
      )
      if (page.done) break
      if (
        bytes >= Math.min(config.maxThreadMiB, config.maxMemoryMiB) * 1024 ** 2 ||
        records.length >= config.maxMessages
      ) {
        partial = true
        break
      }
      await new Promise<void>((r) => setImmediate(r))
    }
    if (revision !== undefined)
      contextMemoryStore.install(key, { revision, total, records, controls, partial }, token)
  })()
  pending.set(key, run)
  try {
    await run
  } finally {
    if (pending.get(key) === run) pending.delete(key)
  }
}
export async function conversationContext(
  root: string | null,
  id: string,
  query: string,
  settings: AppSettings,
  options: {
    excludeId?: string
    projectRoot?: string | null
    tokens?: number
    signal?: AbortSignal
  } = {}
) {
  await warmConversationMemory(root, id, settings, options.signal)
  if (contextMemoryStore.config.enabled && !contextMemoryStore.has(memoryKey(root, id)))
    await warmConversationMemory(root, id, settings, options.signal)
  // A different workspace may have warmed while this request awaited worker I/O.
  // Reapply this request's policy before selection; later changes fence the snapshot.
  contextMemoryStore.configure(
    settings.agent.contextMemory ?? ContextMemorySettingsSchema.parse({})
  )
  return contextMemoryStore.select(memoryKey(root, id), query, options)
}
export async function saveMemoryControls(
  root: string | null,
  id: string,
  controls: MemoryControls
) {
  const saved = await workspaceRequest({
    type: 'context-controls',
    dir: dir(root),
    id,
    write: controls
  })
  contextMemoryStore.setControls(memoryKey(root, id), saved)
  return saved
}
