import { createHash } from 'crypto'
import { isNativeGgufRef } from './builtin-model'
import { appendTaskEvent } from './task-ledger'
import { countContextItems } from './agent/context-compiler'
import {
  type ContextBundle,
  type ContextBundleItem,
  type ContextDispatch
} from '../../../src/shared/context-memory'

const MAX_REMEMBERED = 64
const latest = new Map<string, ContextDispatch>()
const reported = new WeakMap<ContextBundle, string>()

export const lastContextDispatch = (namespace: string) => latest.get(namespace)

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
  tools?: unknown
  adapted?: boolean
}): void {
  const bundle = input.compiled.find((message) => message.contextBundle)?.contextBundle
  if (!bundle) return
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
    model: input.model,
    destination: isNativeGgufRef(input.model) ? 'local' : 'remote',
    adapted: Boolean(input.adapted),
    requestDigest: createHash('sha256')
      .update(JSON.stringify([input.outbound, input.tools ?? null]))
      .digest('hex'),
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
