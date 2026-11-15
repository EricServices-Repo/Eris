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

/** A user's own Ollama daemon (local or LAN) — never the hosted Eris Cloud server. */
export function isLocalOllamaConnection(c: Pick<ModelConnection, 'id' | 'type' | 'provider'>): boolean {
  if (isErisCloudConnection(c)) return false
  return c.type !== 'builtin' && (c.provider === 'ollama' || c.id === 'ollama')
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
}

export function parseHostedModels(raw: unknown): ErisHostedModels | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean') return null
  return { enabled: r.enabled, baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : undefined }
}
