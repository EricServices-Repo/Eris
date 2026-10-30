import { HydrationScheduler, type HydrationPriority } from './context-hydration-scheduler'
import { SharedHydration } from './context-hydration'
import { createHash } from 'crypto'
import { userDataRoot, userChatsDir, workspaceChatsDir } from './paths'
import { realpathAllowMissing } from './workspace-fs'
import { getResolvedSettings } from './settings'
import { workspaceRequest } from './workspace-worker-client'
import { contextMemoryStore } from './context-memory-store'
import { lastContextDispatch } from './context-dispatch'
import type { AppSettings, ChatThread } from '../../../src/shared/settings-schema'
import {
  ContextMemorySettingsSchema,
  type ContextHeader,
  type MemoryControls
} from '../../../src/shared/context-memory'
const pending = new Map<string, SharedHydration>()
const scheduler = new HydrationScheduler()
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
  signal?: AbortSignal,
  priority: HydrationPriority = signal ? 'foreground' : 'background'
) {
  const policy = ContextMemorySettingsSchema.parse(settings.agent.contextMemory ?? {})
  // Only profile settings govern the process allocator. Workspace disclosure,
  // scope and prompt budgets must never reconfigure another request.
  contextMemoryStore.configure(getResolvedSettings(null).agent.contextMemory)
  const key = memoryKey(root, id)
  contextMemoryStore.configureNamespace(key, policy)
  if (!policy.enabled || !contextMemoryStore.config.enabled) return
  signal?.throwIfAborted()
  const existing = pending.get(key)
  if (existing) {
    if (priority === 'foreground') scheduler.promote(key)
    await existing.wait(signal)
    return
  }
  if (pending.size >= 10) {
    const discarded = priority === 'foreground' ? scheduler.discardSpeculative() : undefined
    if (!discarded) throw new Error('Conversation hydration admission is full')
    pending.delete(discarded)
  }
  const config = { ...contextMemoryStore.config }
  async function hydrate(loadSignal: AbortSignal) {
    const header = await workspaceRequest({ type: 'context-header', dir: dir(root), id })
    loadSignal.throwIfAborted()
    if (!header) {
      contextMemoryStore.clear(key)
      return
    }
    const current = contextMemoryStore.matchesSource(key, header)
    const seed = current ? contextMemoryStore.backfillSeed(key) : undefined
    if (current && !seed) return
    if (contextMemoryStore.has(key) && !seed) contextMemoryStore.clear(key)
    const token = contextMemoryStore.token(key)
    const controls = await workspaceRequest({ type: 'context-controls', dir: dir(root), id })
    let before: number | undefined = seed?.before,
      beforeContentOffset: number | undefined = seed?.beforeContentOffset,
      revision: number | undefined = seed?.revision,
      sourceEpoch: string | undefined = seed?.sourceEpoch,
      total = seed?.total ?? 0,
      bytes =
        seed?.records.reduce(
          (n, r) => n + Buffer.byteLength(JSON.stringify(r.message)) * 4 + 512,
          0
        ) ?? 0,
      partial = false,
      complete = false,
      corruptRecords = seed?.corruptRecords ?? 0
    const corruptOrdinals = new Set<number>(seed?.corruptOrdinals ?? [])
    const records: Array<{ ordinal: number; message: ChatThread['messages'][number] }> = [
      ...(seed?.records ?? [])
    ]
    for (
      let pages = 0;
      pages < Math.ceil(Math.min(config.maxMessages, policy.maxMessages) / 500) + 1;
      pages++
    ) {
      loadSignal.throwIfAborted()
      if (token !== contextMemoryStore.token(key)) return
      const page = await workspaceRequest({
        type: 'context-page',
        dir: dir(root),
        id,
        before,
        beforeContentOffset
      })
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
      beforeContentOffset = page.beforeContentOffset
      partial ||= page.omitted > 0 || (page.metadataOmitted ?? 0) > 0
      const overlappingCorruption = (page.corruptOrdinals ?? []).filter((ordinal) =>
        corruptOrdinals.has(ordinal)
      ).length
      corruptRecords += Math.max(0, (page.corruptRecords ?? 0) - overlappingCorruption)
      for (const ordinal of page.corruptOrdinals ?? [])
        if (corruptOrdinals.size < 100500) corruptOrdinals.add(ordinal)
      records.unshift(...page.records)
      bytes += page.records.reduce(
        (n, r) => n + Buffer.byteLength(JSON.stringify(r.message)) * 4 + 512,
        0
      )
      if (page.done) {
        complete = true
        break
      }
      if (
        bytes >=
          Math.min(config.maxThreadMiB, policy.maxThreadMiB, config.maxMemoryMiB) * 1024 ** 2 ||
        records.length >= Math.min(config.maxMessages, policy.maxMessages)
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
        {
          revision,
          sourceEpoch,
          total,
          records,
          controls,
          partial: partial || !complete,
          corruptRecords,
          corruptOrdinals: [...corruptOrdinals]
        },
        token
      )
  }
  const load = new SharedHydration((loadSignal) =>
    scheduler.run(key, root ?? '<profile>', priority, loadSignal, () => hydrate(loadSignal))
  )
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
    coveredSourceIds?: readonly string[]
    excludeId?: string
    projectRoot?: string | null
    tokens?: number
    signal?: AbortSignal
  } = {}
) {
  const policy = ContextMemorySettingsSchema.parse(settings.agent.contextMemory ?? {})
  options.signal?.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), policy.foregroundDeadlineMs)
  timer.unref?.()
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal
  try {
    await warmConversationMemory(root, id, settings, signal)
    if (contextMemoryStore.config.enabled && !contextMemoryStore.has(memoryKey(root, id)))
      await warmConversationMemory(root, id, settings, signal)
    return await contextMemoryStore.select(memoryKey(root, id), query, {
      ...options,
      signal,
      policy
    })
  } catch (error) {
    options.signal?.throwIfAborted() // User cancellation is not a recall fallback.
    if (!deadline.signal.aborted) throw error
    return contextMemoryStore.unavailable(
      memoryKey(root, id),
      `Optional conversation recall reached its ${policy.foregroundDeadlineMs} ms deadline; using canonical recent history only. Resident coverage is shown; no historical facts were selected.`,
      policy.shareWithRemoteModels
    )
  } finally {
    clearTimeout(timer)
  }
}
export async function saveMemoryControls(
  root: string | null,
  id: string,
  controls: MemoryControls,
  expectedSource?: ContextHeader
) {
  const saved = await workspaceRequest({
    type: 'context-controls',
    dir: dir(root),
    id,
    write: controls,
    expectedSource
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
    lastDispatch: lastContextDispatch(memoryKey(root, id)),
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
