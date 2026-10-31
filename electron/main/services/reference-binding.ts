import { abortable } from './context-hydration'
import { isNativeGgufRef } from './builtin-model'
import { recommendationSources, referenceItemDigest } from './recommendation-catalog'
import { workspaceRequest } from './workspace-worker-client'
import { userChatsDir, workspaceChatsDir } from './paths'
import { getResolvedSettings } from './settings'
import { selectRecommendations } from '../../../src/shared/recommendations'
import type { AppSettings } from '../../../src/shared/settings-schema'
import type { TaskContract, TaskRecommendation } from '../../../src/shared/task-contract'
import type { TaskReferenceBinding, ReferenceSource } from '../../../src/shared/reference-binding'

export const asksHistoricalReference = (text: string) =>
  /\b(?:those|these|them|the\s+(?:first|second|third|fourth|fifth|last)\s+(?:one|item|recommendation)|(?:item|recommendation)\s*#?\d+)\b/i.test(
    text
  ) || /\b[a-f0-9]{16}\b/i.test(text)
export type ResolvedReference = {
  binding: TaskReferenceBinding
  recommendations: TaskRecommendation[]
}
export async function bindTaskReferences(input: {
  root: string | null
  threadId: string
  text: string
  settings: AppSettings
  models: string[]
  recentSourceIds?: string[]
}): Promise<ResolvedReference | undefined> {
  if (!asksHistoricalReference(input.text)) return undefined
  const explicit = [
    ...new Set(input.text.match(/\b[a-f0-9]{16}\b/gi)?.map((id) => id.toLowerCase()) ?? [])
  ]
  const catalog = recommendationSources(input.root, input.threadId)
  if (!catalog.length && !explicit.length) return undefined // legacy recent-history path
  const recent = new Set(input.recentSourceIds ?? [])
  const allRecent = catalog.every((source) => recent.has(source.messageId))
  const remotePolicy = allRecent
    ? 'recent'
    : input.settings.agent.contextMemory.shareWithRemoteModels
      ? 'opt-in'
      : 'local-only'
  const fail = (
    reason: string,
    status: TaskReferenceBinding['status'] = 'unavailable'
  ): ResolvedReference => ({
    binding: { status, remotePolicy, sources: [], reason },
    recommendations: []
  })
  const candidates = explicit.length
    ? catalog.filter((source) => source.items.some((item) => explicit.includes(item.id)))
    : catalog
  if (
    !input.settings.agent.contextMemory.enabled &&
    candidates.some((source) => !recent.has(source.messageId))
  )
    return fail(
      'Historical recall is disabled; clarify the reference using current conversation input.'
    )
  if (!candidates.length)
    return fail(
      'The referenced recommendation ID is not in the retained artifact catalog; clarify which source to use.'
    )
  const result = await abortable(
    workspaceRequest({
      type: 'context-reference-sources',
      dir: input.root ? workspaceChatsDir(input.root) : userChatsDir(),
      id: input.threadId,
      sources: candidates
    }),
    [AbortSignal.timeout(input.settings.agent.contextMemory.foregroundDeadlineMs)]
  )
  const eligible = result.sources.filter((source) => source.recommendations.length)
  if (!eligible.length)
    return fail(
      'Referenced sources were deleted, rewritten, excluded, or are unavailable. Clarify before editing.'
    )
  if (!explicit.length && eligible.length !== 1) {
    if (remotePolicy === 'local-only' && input.models.some((model) => !isNativeGgufRef(model)))
      return fail(
        'Older recommendation sources are local-only. Choose a local model or explicitly enable remote recall.'
      )
    const choices = eligible
      .slice(0, 4)
      .map(
        (source) =>
          `${source.messageId}: ${source.recommendations
            .slice(0, 4)
            .map((item) => item.id)
            .join(', ')}`
      )
      .join('; ')
    return fail(
      `More than one earlier recommendation batch is eligible. Specify stable item IDs before editing. Source choices (up to four): ${choices}`,
      'ambiguous'
    )
  }
  const recommendations: TaskRecommendation[] = []
  const sources: ReferenceSource[] = []
  for (const source of eligible) {
    const selected = explicit.length
      ? source.recommendations.filter((item) => explicit.includes(item.id))
      : selectRecommendations(input.text, source.recommendations).selected
    if (!selected.length) continue
    sources.push({
      messageId: source.messageId,
      projectRoot: source.projectRoot,
      items: selected.map((item) => ({ id: item.id, digest: referenceItemDigest(item) }))
    })
    for (const item of selected)
      if (!recommendations.some((known) => known.id === item.id)) recommendations.push(item)
  }
  if (
    !recommendations.length ||
    explicit.some((id) => !recommendations.some((item) => item.id === id))
  )
    return fail('Some referenced IDs cannot be resolved to current eligible sources.')
  if (new Set(sources.map((source) => source.projectRoot)).size !== 1)
    return fail(
      'The selected references belong to different projects; clarify the intended scope.',
      'ambiguous'
    )
  // Narrow the destination ceiling to the sources actually selected.
  const policy = sources.every((source) => recent.has(source.messageId)) ? 'recent' : remotePolicy
  if (policy === 'local-only' && input.models.some((model) => !isNativeGgufRef(model)))
    return fail(
      'Older recommendation sources are local-only. Choose a local model or explicitly enable remote recall.'
    )
  return {
    binding: {
      status: 'bound',
      remotePolicy: policy,
      sources,
      sourceVersion: result.sourceVersion ?? undefined
    },
    recommendations
  }
}

/** Shared by generation, direct-provider diagnostics, outcome review and mutation admission. */
export async function assertTaskReferences(
  task: Pick<TaskContract, 'referenceBinding' | 'scope' | 'threadId'>,
  settings: AppSettings,
  model: string
): Promise<void> {
  const binding = task.referenceBinding
  if (!binding) return
  if (binding.status !== 'bound')
    throw new Error(binding.reason || 'Historical references require clarification.')
  const current = getResolvedSettings(task.scope.workspaceRoot)
  if (
    binding.remotePolicy !== 'recent' &&
    (!current.agent.contextMemory.enabled || !settings.agent.contextMemory.enabled)
  )
    throw new Error('Historical recall is disabled for these recommendation sources.')
  if (
    !isNativeGgufRef(model) &&
    (binding.remotePolicy === 'local-only' ||
      (binding.remotePolicy === 'opt-in' &&
        (!settings.agent.contextMemory.shareWithRemoteModels ||
          !current.agent.contextMemory.shareWithRemoteModels)))
  )
    throw new Error('The destination may not receive these historical recommendation sources.')
  if (!task.threadId) throw new Error('Historical reference thread is unavailable.')
  if (binding.sources.some((source) => source.projectRoot !== task.scope.projectRoot))
    throw new Error('The task scope no longer matches its historical reference sources.')
  const result = await abortable(
    workspaceRequest({
      type: 'context-reference-sources',
      dir: task.scope.workspaceRoot ? workspaceChatsDir(task.scope.workspaceRoot) : userChatsDir(),
      id: task.threadId,
      sources: binding.sources
    }),
    [AbortSignal.timeout(settings.agent.contextMemory.foregroundDeadlineMs)]
  )
  if (
    binding.sources.some(
      (source) =>
        !result.sources.some(
          (current) =>
            current.messageId === source.messageId &&
            current.projectRoot === source.projectRoot &&
            source.items.every((item) =>
              current.recommendations.some(
                (recommendation) =>
                  recommendation.id === item.id &&
                  referenceItemDigest(recommendation) === item.digest
              )
            )
        )
    )
  )
    throw new Error(
      'Historical recommendation sources changed or lost eligibility; resolve the references again before proceeding.'
    )
}
