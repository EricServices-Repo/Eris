import { abortable, SharedHydration } from './context-hydration'
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
const pending = new Map<string, SharedHydration>()
const idleSweep = setInterval(() => contextMemoryStore.sweep(), 60000)
idleSweep.unref()
export const memoryKey = (root: string | null, thread: string) =>
  createHash('sha256')
    .update(JSON.stringify([userDataRoot(), root ? realpathAllowMissing(root) : null, thread]))
    .digest('hex')
const dir = (root: string | null) => (root ? workspaceChatsDir(root) : userChatsDir())
export function invalidateConversationMemory(root: string | null, id: string) {
  const key = memoryKey(root, id)
  pending.get(key)?.controller.abort()
  contextMemoryStore.clear(key)
}
export function updateConversationMemory(root: string | null, thread: ChatThread) {
  contextMemoryStore.append(
    memoryKey(root, thread.id),
    thread.contextRevision ?? 0,
    thread.messageCount ?? thread.messages.length,
    thread.messages,
    thread.messageOffset ?? 0,
    thread.contextEpoch
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
  if (!contextMemoryStore.config.enabled) return
  signal?.throwIfAborted()
  const header = await abortable(workspaceRequest({ type: 'context-header', dir: dir(root), id }), [
    signal
  ])
  if (!header) {
    contextMemoryStore.clear(key)
    return
  }
  const current = contextMemoryStore.matchesSource(key, header)
  const seed = current ? contextMemoryStore.backfillSeed(key) : undefined
  if (current && !seed) return
  if (contextMemoryStore.has(key) && !seed) contextMemoryStore.clear(key)
  const existing = pending.get(key)
  if (existing) {
    await existing.wait(signal)
    return
  }
  if (pending.size >= 2) return
  const token = contextMemoryStore.token(key),
    config = { ...contextMemoryStore.config }
  const load = new SharedHydration(async (loadSignal) => {
    const controls = await workspaceRequest({ type: 'context-controls', dir: dir(root), id })
    let before: number | undefined = seed?.before,
      revision: number | undefined = seed?.revision,
      sourceEpoch: string | undefined = seed?.sourceEpoch,
      total = seed?.total ?? 0,
      bytes =
        seed?.records.reduce(
          (n, r) => n + Buffer.byteLength(JSON.stringify(r.message)) * 4 + 512,
          0
        ) ?? 0,
      partial = false
    const records: Array<{ ordinal: number; message: ChatThread['messages'][number] }> = [
      ...(seed?.records ?? [])
    ]
    for (let pages = 0; pages < Math.ceil(config.maxMessages / 500) + 1; pages++) {
      loadSignal.throwIfAborted()
      if (token !== contextMemoryStore.token(key)) return
      const page = await workspaceRequest({ type: 'context-page', dir: dir(root), id, before })
      loadSignal.throwIfAborted()
      if (!page) return
      if (
        revision !== undefined &&
        (revision !== page.revision || sourceEpoch !== page.sourceEpoch)
      ) {
        // A backfill must not leave its older seed eligible after a canonical rewrite/append.
        if (seed && token === contextMemoryStore.token(key)) contextMemoryStore.clear(key)
        return // concurrent transcript mutation; next request retries, never publish a mixed snapshot
      }
      revision = page.revision
      sourceEpoch = page.sourceEpoch
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
    loadSignal.throwIfAborted()
    if (revision !== undefined)
      contextMemoryStore.install(
        key,
        { revision, sourceEpoch, total, records, controls, partial },
        token
      )
  })
  pending.set(key, load)
  void load.done
    .finally(() => {
      if (pending.get(key) === load) pending.delete(key)
    })
    .catch(() => {})
  await load.wait(signal)
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

/** Inspection controls belong to SQLite, even when optional RAM recall is off or unavailable. */
export async function inspectConversationMemory(
  root: string | null,
  id: string,
  query: string,
  settings: AppSettings
) {
  const [controls, thread] = await Promise.all([
    workspaceRequest({ type: 'context-controls', dir: dir(root), id }),
    workspaceRequest({ type: 'chat-get', dir: dir(root), id, page: { limit: 1 } })
  ])
  if (!thread) throw new Error('Chat not found')
  let inspection
  let failure: string | undefined
  try {
    inspection = (await conversationContext(root, id, query, settings)).inspection
  } catch (error) {
    invalidateConversationMemory(root, id)
    inspection = (await contextMemoryStore.select(memoryKey(root, id), query)).inspection
    failure = error instanceof Error ? error.message : 'Conversation recall unavailable'
  }
  return {
    ...inspection,
    controls,
    controlsAvailable: true,
    manifest: {
      ...inspection.manifest,
      ...(inspection.manifest.retainedMessages === 0
        ? {
            totalMessages: thread.messageCount ?? thread.messages.length,
            revision: thread.contextRevision ?? 0
          }
        : {}),
      ...(failure ? { reason: failure } : {})
    }
  }
}
