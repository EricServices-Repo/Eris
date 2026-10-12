import { config } from './config.js'
import { audit } from './observe.js'

export type AuthContext = {
  owner: string
  plan: 'free' | 'pro'
  token: string
}

type CacheEntry = { auth: AuthContext; expiresAt: number }

const AUTH_TTL_MS = 120_000
const authCache = new Map<string, CacheEntry>()

function erisMeUrl(): string {
  return `${config.erisApiBase.replace(/\/+$/, '')}/me.php`
}

function cacheGet(token: string): AuthContext | null {
  const hit = authCache.get(token)
  if (!hit) return null
  if (Date.now() > hit.expiresAt) {
    authCache.delete(token)
    return null
  }
  return hit.auth
}

function cacheSet(auth: AuthContext): void {
  if (!auth.token) return
  authCache.set(auth.token, { auth, expiresAt: Date.now() + AUTH_TTL_MS })
  // Bound cache size
  if (authCache.size > 500) {
    const first = authCache.keys().next().value
    if (first) authCache.delete(first)
  }
}

/**
 * Validate Authorization: Bearer eseris_… against EricServic.es.
 * Results are cached ~2 minutes to avoid me.php on every job poll.
 */
export async function authenticateRequest(
  authorization: string | undefined,
  opts?: { requireAuth?: boolean }
): Promise<{ ok: true; auth: AuthContext } | { ok: false; status: number; error: string }> {
  const header = (authorization || '').trim()
  const m = /^Bearer\s+(\S+)/i.exec(header)
  const token = m?.[1]?.trim() || ''

  if (!token) {
    if (config.allowAnonymous && !opts?.requireAuth) {
      return { ok: true, auth: { owner: 'anonymous', plan: 'free', token: '' } }
    }
    return { ok: false, status: 401, error: 'Authorization Bearer token required (EricServic.es).' }
  }

  const cached = cacheGet(token)
  if (cached) return { ok: true, auth: cached }

  try {
    const res = await fetch(erisMeUrl(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'eris-cloud-agent'
      },
      signal: AbortSignal.timeout(8_000)
    })
    const text = await res.text()
    let data: Record<string, unknown> = {}
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      return { ok: false, status: 502, error: 'EricServic.es returned a non-JSON response.' }
    }
    if (!res.ok || data.ok === false) {
      const error =
        typeof data.error === 'string' ? data.error : `EricServic.es auth failed (${res.status})`
      audit('auth_failed', { status: res.status, error: error.slice(0, 200) })
      authCache.delete(token)
      return { ok: false, status: 401, error }
    }
    const owner =
      String(data.username || data.owner || data.email || '').trim() ||
      `user-${token.slice(-8)}`
    const planRaw = String(
      (data.plan as string) ||
        ((data.profile as Record<string, unknown> | undefined)?.plan as string) ||
        'free'
    ).toLowerCase()
    const plan: 'free' | 'pro' = planRaw === 'pro' ? 'pro' : 'free'
    const auth = { owner, plan, token }
    cacheSet(auth)
    return { ok: true, auth }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    audit('auth_error', { error: error.slice(0, 200) })
    return { ok: false, status: 502, error: `Could not reach EricServic.es: ${error}` }
  }
}

export function jobVisibleTo(jobOwner: string | undefined, auth: AuthContext): boolean {
  if (config.allowAnonymous && auth.owner === 'anonymous') return true
  if (!jobOwner || jobOwner === 'anonymous') return auth.owner === 'anonymous' || auth.plan === 'pro'
  return jobOwner === auth.owner
}
