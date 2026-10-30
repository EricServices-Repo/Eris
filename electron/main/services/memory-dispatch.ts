import { isNativeGgufRef } from './builtin-model'
import { memoryKey, warmConversationMemory } from './context-memory'
import { contextMemoryStore, MEMORY_PROMPT_HEADER } from './context-memory-store'
import { getResolvedSettings } from './settings'
import { appendTaskEvent } from './task-ledger'
import {
  ContextMemorySettingsSchema,
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
  token: string
  revoked: Set<string>
}
const leases = new Set<EvidenceLease>()

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
    revoked: new Set()
  }
  leases.add(lease)
  return () => leases.delete(lease)
}

const policyOf = (lease: EvidenceLease) =>
  ContextMemorySettingsSchema.parse(getResolvedSettings(lease.root).agent.contextMemory ?? {})

/** Reload a cleared snapshot once so a rewrite that kept a source does not lose it. */
async function reloadIfCleared(lease: EvidenceLease) {
  const { key, token, root, threadId } = lease
  if (contextMemoryStore.revocationToken(key) === token || contextMemoryStore.has(key)) return
  try {
    const signal = AbortSignal.timeout(policyOf(lease).foregroundDeadlineMs)
    await warmConversationMemory(root, threadId, getResolvedSettings(root), signal)
  } catch {
    /* Without a snapshot the items cannot be proven eligible, so they are dropped. */
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
  const marker = line.slice(0, line.indexOf('] ') + 2)
  for (let at = content.indexOf(marker); at >= 0; at = content.indexOf(marker, at)) {
    let end = marker.length
    while (end < line.length && content[at + end] === line[end]) end++
    content = content.slice(0, at) + content.slice(at + end)
  }
  return content
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
  return { messages: outbound, revoked }
}
