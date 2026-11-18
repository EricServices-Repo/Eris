import type { ModelConnection } from './settings-schema'

/**
 * Eris Cloud: the EricServic.es-hosted Ollama server, reached through nginx at
 * agents.ericservic.es. Requests authenticate with the account's Eris device
 * token (eseris_…) — the same secret the app stores after EricServic.es sign-in.
 */
export const ERIS_CLOUD_CONNECTION_ID = 'eris-cloud'
export const ERIS_CLOUD_NAME = 'Eris Cloud'
export const ERIS_CLOUD_BASE_URL = 'https://agents.ericservic.es/v1'
/** Secret key of the EricServic.es device token (see electron/main/services/ericservices.ts). */
export const ERIS_CLOUD_TOKEN_REF = 'ericServices.token'

export function isErisCloudConnection(c: Pick<ModelConnection, 'id'>): boolean {
  return c.id === ERIS_CLOUD_CONNECTION_ID
}

/**
 * Eris Cloud models are named `cloud:<model>` everywhere in Eris (picker, settings,
 * Auto, saved selections), so a hosted model is never confused with the same model
 * on the user's own Ollama. The server itself only knows the bare id.
 */
export const ERIS_CLOUD_MODEL_PREFIX = 'cloud:'

export function isErisCloudModelRef(ref: string): boolean {
  return ref.startsWith(ERIS_CLOUD_MODEL_PREFIX) && ref.length > ERIS_CLOUD_MODEL_PREFIX.length
}

/** `cloud:<model>` for a model id the Eris Cloud server lists. */
export function erisCloudModelRef(id: string): string {
  return isErisCloudModelRef(id) ? id : `${ERIS_CLOUD_MODEL_PREFIX}${id}`
}

/** The model ref Eris uses for a model listed by a connection. */
export function connectionModelRef(c: Pick<ModelConnection, 'id'>, id: string): string {
  return isErisCloudConnection(c) ? erisCloudModelRef(id) : id
}

/** The id a provider's API expects: an Eris Cloud ref without its `cloud:` prefix. */
export function providerModelId(ref: string): string {
  return isErisCloudModelRef(ref) ? ref.slice(ERIS_CLOUD_MODEL_PREFIX.length) : ref
}

/** A user's own Ollama daemon (local or LAN) — never the hosted Eris Cloud server. */
export function isLocalOllamaConnection(c: Pick<ModelConnection, 'id' | 'type' | 'provider'>): boolean {
  if (isErisCloudConnection(c)) return false
  return c.type !== 'builtin' && (c.provider === 'ollama' || c.id === 'ollama')
}

/**
 * The Ollama server the Ollama settings card manages and model pulls target: id `ollama`,
 * else the first local Ollama connection. Other Ollama servers are ordinary connections (#677).
 */
export function primaryOllamaConnection<T extends Pick<ModelConnection, 'id' | 'type' | 'provider'>>(
  connections: readonly T[]
): T | undefined {
  return (
    connections.find((c) => c.id === 'ollama' && isLocalOllamaConnection(c)) ??
    connections.find((c) => isLocalOllamaConnection(c))
  )
}

/** Canonical Eris Cloud connection fields; user-controlled fields are preserved. */
export function normalizeErisCloudConnection<T extends Record<string, unknown>>(c: T): T {
  return {
    ...c,
    id: ERIS_CLOUD_CONNECTION_ID,
    name: ERIS_CLOUD_NAME,
    type: 'openai-compatible',
    provider: 'ollama',
    baseUrl: ERIS_CLOUD_BASE_URL,
    apiKeyRef: ERIS_CLOUD_TOKEN_REF
  } as T
}

/** `hostedModels` block from GET /api/eris/v1/me.php. */
export interface ErisHostedModels {
  enabled: boolean
  baseUrl?: string
  allowance?: { limit: number; remaining: number }
}

export function parseHostedModels(raw: unknown): ErisHostedModels | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean') return null
  const allowance = r.allowance as Record<string, unknown> | undefined
  const limit = allowance?.limit
  const remaining = allowance?.remaining
  return {
    enabled: r.enabled,
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : undefined,
    ...(r.enabled && allowance?.available === true && allowance.window_days === 7 &&
        typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 &&
        typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= limit
      ? { allowance: { limit, remaining } }
      : {})
  }
}
