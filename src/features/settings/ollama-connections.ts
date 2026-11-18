import { isLoopbackUrl } from '../../shared/model-destination'
import type { ModelConnection } from '../../shared/settings-schema'

/** Ollama window sizing fields (#677). */
export type OllamaContextSettings = Partial<Pick<ModelConnection, 'contextFit' | 'kvCacheType' | 'vramGiB'>>

/** What the connection editor holds that becomes part of the saved connection. */
export type ConnectionDraftFields = {
  id: string
  name: string
  provider: string
  toolProtocol?: ModelConnection['toolProtocol']
  enabled: boolean
  baseUrl: string
  modelsText: string
  modelLimits: NonNullable<ModelConnection['modelLimits']>
  reasoning?: ModelConnection['reasoning']
  recallApproved: boolean
  ollama: OllamaContextSettings
  /** The saved connection, so fields the editor does not show survive a save. */
  original?: ModelConnection
}

export function parseModels(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Replace (or with null, drop) only the primary Ollama connection. Other Ollama servers
 * are managed under Model connections and must survive edits here (#677).
 */
export function withPrimaryOllama(
  connections: readonly ModelConnection[],
  primaryId: string | undefined,
  next: ModelConnection | null
): ModelConnection[] {
  const others = connections.filter((c) => c.id !== (primaryId ?? next?.id))
  const builtin = others.filter((c) => c.type === 'builtin')
  const rest = others.filter((c) => c.type !== 'builtin')
  return next ? [...builtin, next, ...rest] : [...builtin, ...rest]
}

/**
 * The connection a draft saves. Starts from the saved connection so fields the editor
 * does not show (keep-loaded, window fitting) survive; withdrawn approvals are dropped.
 */
export function connectionFromDraft(draft: ConnectionDraftFields, apiKeyRef: string): ModelConnection {
  const baseUrl = draft.baseUrl.trim().replace(/\/$/, '')
  const provider = draft.provider || 'custom'
  const next: ModelConnection = {
    ...(draft.original ?? {}),
    id: draft.id,
    name: draft.name.trim(),
    type: 'openai-compatible',
    provider,
    toolProtocol: draft.toolProtocol ?? 'native-tools',
    enabled: draft.enabled,
    baseUrl,
    apiKeyRef,
    models: parseModels(draft.modelsText),
    modelLimits: draft.modelLimits
  }
  if (draft.reasoning) next.reasoning = draft.reasoning
  else delete next.reasoning
  if (draft.recallApproved && !isLoopbackUrl(baseUrl)) next.recallApprovedUrl = baseUrl
  else delete next.recallApprovedUrl
  for (const field of ['contextFit', 'kvCacheType', 'vramGiB'] as const) {
    const value = provider === 'ollama' ? draft.ollama[field] : undefined
    if (value === undefined) delete next[field]
    else (next as Record<string, unknown>)[field] = value
  }
  return next
}

