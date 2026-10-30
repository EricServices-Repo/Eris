import { createHash } from 'crypto'
import { isNativeGgufRef } from './builtin-model'
import { memoryKey, warmConversationMemory } from './context-memory'
import { contextMemoryStore, MEMORY_PROMPT_HEADER } from './context-memory-store'
import { workspaceRequest } from './workspace-worker-client'
import { userChatsDir, workspaceChatsDir } from './paths'
import { abortable } from './context-hydration'
import type { ContextHeader } from '../../../src/shared/context-memory'
import { getResolvedSettings } from './settings'
import { appendTaskEvent } from './task-ledger'
import {
  ContextMemorySettingsSchema,
  memoryItemMarker,
  type MemoryPrompt,
  type MemoryPromptItem
} from '../../../src/shared/context-memory'

type EvidenceLease = {
  root: string | null
  threadId: string
  taskId: string
  key: string
  items: MemoryPromptItem[]
  allowRemote: boolean
  sourceVersion?: ContextHeader
  token: string
  revoked: Set<string>
  /** Set once a model has received an item; digests the messages that predate it. */
  exposure: { clean: Set<string>; intent: unknown } | null
}
const leases = new Set<EvidenceLease>()
export const DERIVED_WITHHELD_NOTICE =
  'Earlier steps in this run used local-only conversation memory and are not shown to this model. Inspect the workspace again rather than assuming their results.'

/** Track recalled items for one request. The returned function ends tracking. */
export function leaseMemoryEvidence(input: {
  root: string | null
  threadId: string
  taskId: string
  prompt: MemoryPrompt
}): () => void {
  const { prompt } = input
  if (!prompt.items?.length || prompt.evidenceToken === undefined) return () => undefined
  const lease: EvidenceLease = {
    root: input.root,
    threadId: input.threadId,
    taskId: input.taskId,
    key: memoryKey(input.root, input.threadId),
    items: prompt.items,
    allowRemote: prompt.allowRemote,
    token: prompt.evidenceToken,
    sourceVersion: prompt.sourceVersion,
    revoked: new Set(),
    exposure: null
  }
  leases.add(lease)
  return () => leases.delete(lease)
}

const policyOf = (lease: EvidenceLease) =>
  ContextMemorySettingsSchema.parse(getResolvedSettings(lease.root).agent.contextMemory ?? {})

/** Reload a cleared snapshot once so a rewrite that kept a source does not lose it. */
async function reloadIfCleared(lease: EvidenceLease) {
  const { key, token, root, threadId } = lease
  try {
    const signal = AbortSignal.timeout(policyOf(lease).foregroundDeadlineMs)
    if (lease.sourceVersion) {
      // This tiny canonical check is mandatory even when optional warming is
      // pressure-paused or another process made the change without main IPC.
      const header = await abortable(
        workspaceRequest({
          type: 'context-header',
          dir: root ? workspaceChatsDir(root) : userChatsDir(),
          id: threadId
        }),
        [signal]
      )
      const old = lease.sourceVersion
      if (!header) {
        contextMemoryStore.clear(key)
        return
      }
      if (
        header.revision !== old.revision ||
        header.sourceEpoch !== old.sourceEpoch ||
        header.messageCount !== old.messageCount ||
        header.controlsRevision !== old.controlsRevision
      ) {
        contextMemoryStore.clear(key)
        await warmConversationMemory(root, threadId, getResolvedSettings(root), signal)
        lease.sourceVersion = header
        return
      }
    }
    if (contextMemoryStore.revocationToken(key) === token || contextMemoryStore.has(key)) return
    await warmConversationMemory(root, threadId, getResolvedSettings(root), signal)
  } catch {
    contextMemoryStore.clear(key) // A source that cannot be revalidated fails closed.
  }
}

/** Synchronous, so nothing can interleave between this check and the transport. */
function settle(lease: EvidenceLease): number {
  const before = lease.revoked.size
  const policy = policyOf(lease)
  lease.allowRemote &&= policy.shareWithRemoteModels
  const token = contextMemoryStore.revocationToken(lease.key)
  const stale = !policy.enabled
    ? lease.items
    : token === lease.token
      ? []
      : contextMemoryStore.ineligible(lease.key, lease.items)
  lease.token = token
  for (const item of stale) lease.revoked.add(item.id)
  const added = lease.revoked.size - before
  if (added)
    appendTaskEvent(lease.taskId, 'memory-revoked', {
      revoked: [...lease.revoked],
      remaining: lease.items.length - lease.revoked.size
    })
  return added
}

/** Removes a rendered item, including one the compiler cut off at its input budget. */
function withoutItem(content: string, line: string) {
  const marker = memoryItemMarker(line)
  for (let at = content.indexOf(marker); at >= 0; at = content.indexOf(marker, at)) {
    let end = marker.length
    while (end < line.length && content[at + end] === line[end]) end++
    content = content.slice(0, at) + content.slice(at + end)
  }
  return content
}

const digest = (message: { content?: unknown }) =>
  createHash('sha256')
    .update(JSON.stringify([(message as { role?: unknown }).role, message.content]))
    .digest('hex')

/** Later messages may repeat what the model read, so they inherit its privacy limit. */
function recordExposure(lease: EvidenceLease, messages: Array<{ content?: unknown }>) {
  if (lease.exposure) return
  const exposed = messages.some(
    ({ content }) =>
      typeof content === 'string' &&
      lease.items.some((item) => content.includes(memoryItemMarker(item.line)))
  )
  if (!exposed) return
  const user = messages.filter((message) => (message as { role?: unknown }).role === 'user')
  lease.exposure = { clean: new Set(messages.map(digest)), intent: user[user.length - 1] }
}

/**
 * Withhold what may derive from private recall. Generated turns, tool output and summaries
 * carry no sentence-level lineage, so everything after exposure is treated as dependent.
 * Compiled system prompts stay because their memory items were already removed.
 */
function withoutDerived<T extends { content?: unknown }>(lease: EvidenceLease, messages: T[]): T[] {
  const { clean, intent } = lease.exposure!
  const kept = messages.filter(
    (message) => clean.has(digest(message)) || 'contextBundle' in message
  )
  if (kept.length === messages.length) return messages
  appendTaskEvent(lease.taskId, 'derived-context-withheld', {
    withheld: messages.length - kept.length,
    kept: kept.length
  })
  const hasUser = kept.some((message) => (message as { role?: unknown }).role === 'user')
  return [
    ...kept,
    ...(hasUser || !intent ? [] : [intent as T]),
    { role: 'system', content: DERIVED_WITHHELD_NOTICE } as unknown as T
  ]
}

/**
 * The outbound messages this destination may receive right now. Retained prompts are
 * never edited, so a later recompile or compaction passes through the same removal.
 */
export async function withEligibleMemory<T extends { content?: unknown }>(
  messages: T[],
  model: string
): Promise<{ messages: T[]; revoked: boolean }> {
  if (!leases.size) return { messages, revoked: false }
  await Promise.all([...leases].map(reloadIfCleared))
  let outbound = messages
  let revoked = false
  for (const lease of leases) {
    if (settle(lease)) revoked = true
    const remoteBlocked = !lease.allowRemote && !isNativeGgufRef(model)
    const removed = lease.items.filter((item) => remoteBlocked || lease.revoked.has(item.id))
    if (!removed.length) continue
    const everything = removed.length === lease.items.length
    outbound = outbound.map((message) => {
      if (typeof message.content !== 'string') return message
      let content = removed.reduce((text, item) => withoutItem(text, item.line), message.content)
      if (everything) content = content.replace(MEMORY_PROMPT_HEADER, '')
      return content === message.content ? message : { ...message, content }
    })
  }
  for (const lease of leases) {
    recordExposure(lease, outbound)
    if (lease.exposure && !lease.allowRemote && !isNativeGgufRef(model))
      outbound = withoutDerived(lease, outbound)
  }
  return { messages: outbound, revoked }
}
