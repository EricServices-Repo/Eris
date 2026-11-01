import { AsyncLocalStorage } from 'async_hooks'
import { invalidEvidenceItems } from './context-evidence'
import { evidenceEpochMatches } from './context-evidence-epochs'
import { createHash } from 'crypto'
import { memoryKey, warmConversationMemory } from './context-memory'
import { contextMemoryStore, evidenceDigest, MEMORY_PROMPT_HEADER } from './context-memory-store'
import { workspaceRequest } from './workspace-worker-client'
import { userChatsDir, workspaceChatsDir } from './paths'
import { abortable } from './context-hydration'
import type { ContextHeader } from '../../../src/shared/context-memory'
import { getResolvedSettings } from './settings'
import { modelDestination } from './model-destination'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { appendTaskEvent } from './task-ledger'
import type { HandoffEvidence } from '../../../src/shared/agent-orchestration'
import {
  ContextMemorySettingsSchema,
  memoryItemMarker,
  type MemoryPrompt,
  type MemoryPromptItem
} from '../../../src/shared/context-memory'

/** One request and whatever it explicitly spawned. Compared by identity. */
export type EvidenceScope = object
type EvidenceLease = {
  /** Undefined only for a lease taken outside any request. */
  scope?: EvidenceScope
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
  exposure: {
    clean: Set<string>
    intent: unknown
    items: Set<string>
    authority?: { role: string; content: string; contextBundle?: { taskId: string } }
  } | null
}
/**
 * A child's own hold on what its handoff derives from. It lives in the job's async context,
 * so it ends with the job on every exit and does not depend on any parent's lease.
 */
type ChildEvidence = HandoffEvidence & {
  key: string
  ceiling: boolean
  token: string
  invalid: Set<string>
}
const leases = new Set<EvidenceLease>()
const childEvidence = new AsyncLocalStorage<ChildEvidence[]>()
const scopes = new AsyncLocalStorage<EvidenceScope>()

export const currentEvidenceScope = () => scopes.getStore()

/** Runs `work` as its own request, or as part of `scope` for a dependent child. */
export const runInEvidenceScope = <T>(work: () => T, scope: EvidenceScope = {}): T =>
  scopes.run(scope, work)

/** The same, for a callback another layer invokes. */
export const inEvidenceScope =
  <A extends unknown[], T>(work: (...args: A) => T) =>
  (...args: A): T =>
    runInEvidenceScope(() => work(...args))

/** Runs a background job under the evidence its handoff carries, and only that. */
export const runWithHandoffEvidence = <T>(
  evidence: readonly HandoffEvidence[] | undefined,
  work: () => T
): T =>
  childEvidence.run(
    (evidence ?? []).map((source) => ({
      ...source,
      key: memoryKey(source.root, source.threadId),
      ceiling: source.allowRemote,
      token: '', // No cached copy can vouch for this until it has been checked.
      invalid: new Set()
    })),
    work
  )

/**
 * What this request's model has been shown, for a handoff written now. Later revalidation
 * needs no lease, so a queued child stays bound after its parent has ended. Evidence a
 * job itself inherited passes on, so a chain of children keeps the first ceiling.
 */
export function captureHandoffEvidence(): HandoffEvidence[] {
  const scope = scopes.getStore()
  const seen = [...leases].filter((lease) => lease.scope === scope && lease.exposure)
  const held = (childEvidence.getStore() ?? []).map(
    ({ root, threadId, ceiling, sourceVersion, items }): HandoffEvidence => ({
      root,
      threadId,
      allowRemote: ceiling,
      sourceVersion,
      items
    })
  )
  return [
    ...held,
    ...seen.map((lease): HandoffEvidence => ({
      root: lease.root,
      threadId: lease.threadId,
      allowRemote: lease.allowRemote,
      sourceVersion: lease.sourceVersion,
      items: lease.items
        .filter((item) => lease.exposure!.items.has(item.id))
        .map(({ id, sourceId, kind, span, text, dependencies }) => ({
          id,
          sourceId,
          kind,
          chars: text.length,
          digest: evidenceDigest(text),
          ...(span ? { offset: span.offset } : {}),
          ...(dependencies ? { dependencies } : {})
        }))
    }))
  ]
}

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
    scope: scopes.getStore(),
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

/** The canonical work for a child's evidence, before the synchronous check below. */
async function refreshChildEvidence(source: ChildEvidence) {
  await reloadIfCleared(source as unknown as EvidenceLease)
  const items = source.items.filter((item) => item.dependencies)
  for (const id of await invalidEvidenceItems(source.root, items as never)) source.invalid.add(id)
}

/** Why this child may not call this model now, or null. Synchronous, like `settle`. */
function childEvidenceProblem(
  source: ChildEvidence,
  blocked: (lease: { allowRemote: boolean; root: string | null }) => boolean
): string | null {
  const policy = ContextMemorySettingsSchema.parse(
    getResolvedSettings(source.root).agent.contextMemory ?? {}
  )
  source.ceiling &&= policy.shareWithRemoteModels
  const stale =
    !policy.enabled ||
    source.invalid.size > 0 ||
    contextMemoryStore.staleEvidence(source.key, source.items).length > 0
  if (stale)
    return 'This handoff drew on conversation memory that has since changed or been removed, so it was withheld. Rebuild the task from current sources.'
  return blocked({ allowRemote: source.ceiling, root: source.root })
    ? 'This handoff drew on local-only conversation memory and cannot go to this model. Choose a model approved for recall, or rebuild the task from eligible sources.'
    : null
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
  for (const item of lease.items)
    if (item.dependencies && !evidenceEpochMatches(item.dependencies)) lease.revoked.add(item.id)
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
    .update(
      JSON.stringify([
        (message as { role?: unknown }).role,
        message.content,
        (message as { tool_calls?: unknown }).tool_calls,
        (message as { tool_call_id?: unknown }).tool_call_id
      ])
    )
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
  const firstSystem = messages.find((message) => (message as { role?: string }).role === 'system')
  const authority =
    firstSystem && typeof firstSystem.content === 'string'
      ? {
          ...firstSystem,
          role: 'system',
          content: lease.items
            .reduce((text, item) => withoutItem(text, item.line), firstSystem.content)
            .replace(MEMORY_PROMPT_HEADER, '')
        }
      : undefined
  const sanitize = (message: { content?: unknown }) =>
    typeof message.content === 'string'
      ? {
          ...message,
          content: lease.items
            .reduce((text, item) => withoutItem(text, item.line), message.content)
            .replace(MEMORY_PROMPT_HEADER, '')
        }
      : message
  lease.exposure = {
    authority,
    clean: new Set([
      ...messages.map(digest),
      ...messages.map((message) => digest(sanitize(message)))
    ]),
    intent: user.length ? sanitize(user[user.length - 1]!) : undefined,
    items: new Set(
      lease.items
        .filter((item) =>
          messages.some(
            ({ content }) =>
              typeof content === 'string' && content.includes(memoryItemMarker(item.line))
          )
        )
        .map((item) => item.id)
    )
  }
}

/**
 * Withhold what may derive from private recall. Generated turns, tool output and summaries
 * carry no sentence-level lineage, so everything after exposure is treated as dependent.
 * A newly compiled system prompt is also derived: its project/task text may echo
 * private evidence. Only the original sanitized authority snapshot may be restored.
 */
function withoutDerived<T extends { content?: unknown }>(
  lease: EvidenceLease,
  messages: T[],
  notice = DERIVED_WITHHELD_NOTICE
): T[] {
  const { clean, intent, authority } = lease.exposure!
  const kept = messages.filter((message) => clean.has(digest(message)))
  const removedSystems = messages.filter(
    (message) => !kept.includes(message) && 'contextBundle' in message
  )
  if (
    removedSystems.some((message) => {
      const taskId = (message as { contextBundle?: { taskId?: string } }).contextBundle?.taskId
      return taskId && taskId !== (authority?.contextBundle?.taskId ?? lease.taskId)
    })
  )
    throw new Error(
      'Derived context cannot be transferred to a different task at this destination. Rebuild the child/review task from eligible sources.'
    )
  if (kept.length === messages.length) return messages
  appendTaskEvent(lease.taskId, 'derived-context-withheld', {
    withheld: messages.length - kept.length,
    kept: kept.length
  })
  const hasUser = kept.some((message) => (message as { role?: unknown }).role === 'user')
  return [
    ...(kept.some((message) => (message as { role?: string }).role === 'system') || !authority
      ? []
      : [authority as unknown as T]),
    ...kept,
    ...(hasUser || !intent ? [] : [intent as T]),
    { role: 'system', content: notice } as unknown as T
  ]
}

type Outbound = { content?: unknown; contextBundle?: { taskId?: string } }

const namesTask = (lease: EvidenceLease, messages: readonly Outbound[]) =>
  messages.some(({ contextBundle }) => contextBundle?.taskId === lease.taskId)

const carriesItems = (lease: EvidenceLease, messages: readonly Outbound[]) =>
  messages.some(
    ({ content }) =>
      typeof content === 'string' &&
      lease.items.some((item) => content.includes(memoryItemMarker(item.line)))
  )

/**
 * Only the request that took a lease answers to it, so an unrelated request keeps its own
 * goal and instructions. A recalled item is private wherever it turns up, so a request
 * that merely carries one loses that item, and nothing else: another lease's intent and
 * authority must never replace its messages. That also means a call that lost its scope
 * cannot send recalled text past this filter.
 */
function leasesFor(messages: readonly Outbound[]) {
  const scope = scopes.getStore()
  const owned = [...leases].filter((lease) => lease.scope === scope || namesTask(lease, messages))
  const carried = [...leases].filter(
    (lease) => !owned.includes(lease) && carriesItems(lease, messages)
  )
  return { owned, carried }
}

/**
 * The outbound messages this destination may receive right now. Retained prompts are
 * never edited, so a later recompile or compaction passes through the same removal.
 */
export async function withEligibleMemory<T extends { content?: unknown }>(
  messages: T[],
  model: string,
  settings: AppSettings
): Promise<{ messages: T[]; revoked: boolean }> {
  const { owned, carried } = leasesFor(messages as Outbound[])
  const relevant = [...owned, ...carried]
  const inherited = childEvidence.getStore() ?? []
  if (!relevant.length && !inherited.length) return { messages, revoked: false }
  /** Needs both the request's settings and current ones, so a revoked approval applies. */
  const recallBlocked = (lease: { allowRemote: boolean; root: string | null }) =>
    !lease.allowRemote &&
    !(
      modelDestination(settings, model).recallAllowed &&
      modelDestination(getResolvedSettings(lease.root), model).recallAllowed
    )
  let dependenciesRevoked = false
  await Promise.all([
    ...inherited.map(refreshChildEvidence),
    ...relevant.map(async (lease) => {
      await reloadIfCleared(lease)
      for (const id of await invalidEvidenceItems(lease.root, lease.items)) {
        if (!lease.revoked.has(id)) dependenciesRevoked = true
        lease.revoked.add(id)
      }
    })
  ])
  // Its text cannot be told apart from the rest of the handoff, so the whole request stops.
  for (const source of inherited) {
    const problem = childEvidenceProblem(source, recallBlocked)
    if (problem) throw new Error(problem)
  }
  let outbound = messages
  let revoked = dependenciesRevoked
  for (const lease of relevant) {
    if (settle(lease)) revoked = true
    const remoteBlocked = recallBlocked(lease)
    const removed = lease.items.filter((item) => remoteBlocked || lease.revoked.has(item.id))
    if (!removed.length) continue
    const everything = removed.length === lease.items.length
    outbound = outbound.map((message) => {
      if (typeof message.content !== 'string') return message
      let content = removed.reduce((text, item) => withoutItem(text, item.line), message.content)
      if (everything) content = content.replace(MEMORY_PROMPT_HEADER, '')
      const cleaned = content === message.content ? message : { ...message, content }
      if (
        (message as { role?: unknown }).role === 'system' &&
        lease.exposure?.clean.has(digest(message))
      )
        lease.exposure.clean.add(digest(cleaned))
      return cleaned
    })
  }
  for (const lease of owned) {
    recordExposure(lease, outbound)
    if (lease.exposure && recallBlocked(lease)) outbound = withoutDerived(lease, outbound)
    else if (lease.exposure && [...lease.revoked].some((id) => lease.exposure!.items.has(id)))
      outbound = withoutDerived(
        lease,
        outbound,
        'Earlier steps used recalled source evidence that is no longer eligible. Inspect current files and verify again; their prior results are withheld.'
      )
  }
  return { messages: outbound, revoked }
}
