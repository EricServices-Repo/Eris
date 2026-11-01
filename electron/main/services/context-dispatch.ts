import { createHash } from 'crypto'
import { appendTaskEvent } from './task-ledger'
import { countContextItems } from './agent/context-compiler'
import { estimateContextTokens } from '../../../src/shared/token-estimate'
import {
  type ContextBundle,
  type ContextBundleItem,
  type ContextDispatch,
  type ContextPreview,
  type MemoryPrompt
} from '../../../src/shared/context-memory'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { contextBudgetTokens } from './agent/context-budget'
import {
  contextCompilationFor,
  compileTaskContext,
  memoryForDestination,
  type ContextCompilationSnapshot
} from './agent/context-compiler'
import { resolveModelCapabilities } from './model-capabilities'
import { modelDestination } from './model-destination'
import { destinationLabel } from '../../../src/shared/model-destination'
import { createTaskContract } from './task-intake'

const MAX_REMEMBERED = 64
const latest = new Map<string, ContextDispatch>()
const reported = new WeakMap<ContextBundle, string>()
// Eight bounded compiler snapshots, maximum ~2 MiB of source characters, expire
// after two minutes. Recalled memory is intentionally excluded from this cache.
const snapshots = new Map<string, { input: ContextCompilationSnapshot; at: number }>()
export const clearContextPreviewSnapshots = () => snapshots.clear()
export function contextPreviewScope(namespace: string): string | null | undefined {
  const snapshot = snapshots.get(namespace)
  if (!snapshot || Date.now() - snapshot.at > 120000) {
    snapshots.delete(namespace)
    return undefined
  }
  return snapshot.input.task.scope.projectRoot
}

export const lastContextDispatch = (namespace: string) => latest.get(namespace)

/**
 * Recompile using an actual task snapshot when query and scope match. Without a
 * matching compilation, return an explicitly labeled upper-bound estimate.
 */
export function previewContextDispatch(input: {
  prompt: MemoryPrompt
  model: string
  query: string
  root: string | null
  settings: AppSettings
  projectRoot?: string | null
}): ContextPreview {
  const { model, prompt, settings } = input
  if (prompt.namespace) contextPreviewScope(prompt.namespace) // expire stale snapshots
  const candidate = prompt.namespace ? snapshots.get(prompt.namespace)?.input : undefined
  const snapshot =
    candidate &&
    candidate.task.originalText.trim() === input.query.trim() &&
    candidate.task.scope.workspaceRoot === input.root &&
    (input.projectRoot === undefined || candidate.task.scope.projectRoot === input.projectRoot)
      ? candidate
      : undefined
  const fallbackTask = createTaskContract({
    workspacePath: input.root,
    text: input.query || 'Preview',
    plan: {
      intent: 'answer',
      agentId: 'chat',
      agentName: 'Chat',
      models: { chat: model, tools: model },
      toolPolicy: 'none'
    } as unknown as Parameters<typeof createTaskContract>[0]['plan']
  })
  const { bundle } = compileTaskContext({
    ...(snapshot ?? { task: fallbackTask, guidance: '', project: '', retrieval: '' }),
    ...memoryForDestination(prompt, model, settings),
    maxInputTokens: Math.min(
      snapshot?.maxInputTokens ?? Infinity,
      contextBudgetTokens(settings, model)
    ),
    toolProtocol: resolveModelCapabilities(settings, model).tools
  })
  return {
    basis: snapshot ? 'last-compilation' : 'estimate',
    ...(snapshot ? { taskId: snapshot.task.taskId, taskRevision: snapshot.task.revision } : {}),
    projectRoot: snapshot ? snapshot.task.scope.projectRoot : input.projectRoot,
    model,
    destination: destinationLabel(modelDestination(settings, model).locality),
    counts: bundle.counts,
    items: bundle.items.map(({ id, status, reason }) => ({ id, status, reason }))
  }
}

type WireMessage = { content?: unknown; contextBundle?: ContextBundle }
const textOf = (messages: readonly WireMessage[]) =>
  messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')

/** The rendered prefix, rebuilt from logged fields so no source text needs to be kept. */
const markerOf = (item: ContextBundleItem) =>
  `[${item.kind}; source ${item.sourceDigest.slice(0, 12)}; ordinal ${item.ordinal}] `

/** Characters of an item that left, and why any are missing, from the text on each side. */
function survived(item: ContextBundleItem, built: string, wire: string) {
  const marker = markerOf(item)
  const from = built.indexOf(marker)
  if (from < 0) return { sentChars: 0, reason: 'revoked-at-dispatch' as const }
  const to = wire.indexOf(marker)
  if (to < 0) return { sentChars: 0, reason: 'provider-budget' as const }
  let sentChars = 0
  while (sentChars < item.sentChars && built[from + sentChars] === wire[to + sentChars]) sentChars++
  return { sentChars, reason: 'provider-budget' as const }
}

/**
 * Report what one request really carried. `compiled` is the context after dispatch
 * eligibility and `outbound` the same request as the destination receives it, so an
 * item removed either way is told apart from one the compiler never fit.
 */
export function reportContextDispatch(input: {
  compiled: readonly WireMessage[]
  outbound: readonly WireMessage[]
  model: string
  settings: AppSettings
  tools?: unknown
  adapted?: boolean
  context?: ContextDispatch['context']
}): void {
  const bundle = input.compiled.find((message) => message.contextBundle)?.contextBundle
  if (!bundle) return
  const snapshot = contextCompilationFor(bundle)
  if (snapshot && bundle.namespace) {
    snapshots.delete(bundle.namespace)
    snapshots.set(bundle.namespace, { input: snapshot, at: Date.now() })
    while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!)
  }
  const built = textOf(input.compiled)
  const wire = textOf(input.outbound)
  const items = bundle.items.map((item): ContextBundleItem => {
    if (!item.sentChars) return item
    const { sentChars, reason } = survived(item, built, wire)
    if (sentChars === item.sentChars) return item
    return { ...item, sentChars, status: sentChars ? 'truncated' : 'omitted', reason }
  })
  const signature = JSON.stringify(items.map((item) => [item.id, item.status, item.reason]))
  const changed = reported.get(bundle) !== signature
  reported.set(bundle, signature)
  const dispatch: ContextDispatch = {
    version: 1,
    taskId: bundle.taskId,
    stablePrefixTokens: bundle.stablePrefixTokens,
    model: input.model,
    destination: destinationLabel(modelDestination(input.settings, input.model).locality),
    adapted: Boolean(input.adapted),
    requestDigest: createHash('sha256')
      .update(JSON.stringify([input.outbound, input.tools ?? null]))
      .digest('hex'),
    estimatedTokens: estimateContextTokens(wire),
    ...(input.context ? { context: input.context } : {}),
    counts: countContextItems(items),
    ...(changed ? { items } : {}),
    at: Date.now()
  }
  appendTaskEvent(bundle.taskId, 'context-dispatched', dispatch)
  if (!bundle.namespace) return
  latest.delete(bundle.namespace)
  latest.set(bundle.namespace, { ...dispatch, items })
  if (latest.size > MAX_REMEMBERED) latest.delete(latest.keys().next().value!)
}

/** Pair the request estimate with provider-reported usage, keeping the two distinguishable. */
export function reportContextUsage(input: {
  compiled: readonly WireMessage[]
  outbound: readonly WireMessage[]
  model: string
  measuredPromptTokens: number | null
}): void {
  const bundle = input.compiled.find((message) => message.contextBundle)?.contextBundle
  if (!bundle) return
  appendTaskEvent(bundle.taskId, 'context-usage', {
    model: input.model,
    estimatedTokens: estimateContextTokens(textOf(input.outbound)),
    measuredPromptTokens: input.measuredPromptTokens,
    source: input.measuredPromptTokens === null ? 'estimate-only' : 'provider-measured'
  })
}
