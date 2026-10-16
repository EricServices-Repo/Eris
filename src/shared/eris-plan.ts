/**
 * Eris Free / Pro entitlements.
 *
 * www.ericservic.es admin sets each user's plan (pulldown → Free | Pro).
 * The Eris API returns it on login /me (all accepted):
 *
 *   profile.plan / profile.erisPlan: "free" | "pro"
 *   profile.planLabel?: "Free" | "Pro"
 *   profile.features?: { priorityCloudAgents, maxDevices, ... }
 *   profile.erisLimits?: { dailyRequests?, dailyTokens?, cloudJobsPerDay? }
 *
 * Pro → all limits null (unlimited). Free → FREE_PLAN_LIMITS (or overrides).
 */

export type ErisPlanId = 'free' | 'pro'

export type ErisPlanLimits = {
  /** null = unlimited */
  dailyRequests: number | null
  dailyTokens: number | null
  cloudJobsPerDay: number | null
}

export type ErisPlanProfileFields = {
  erisPlan?: string | null
  plan?: string | null
  eris_plan?: string | null
  erisLimits?: Partial<{
    dailyRequests: number | null
    dailyTokens: number | null
    cloudJobsPerDay: number | null
  }> | null
  eris_limits?: ErisPlanProfileFields['erisLimits']
}

/**
 * Default Free tier caps (calendar day).
 *
 * Local Composer Lite runs on the user's own machine and costs us nothing, so
 * chat requests and tokens are UNLIMITED on Free (null). Only Cloud Agent jobs —
 * the one thing that spends our compute — are capped. Server-side enforcement
 * lives on www.ericservic.es; the client meters cloud jobs as the local proxy.
 */
export const FREE_PLAN_LIMITS: ErisPlanLimits = {
  dailyRequests: null,
  dailyTokens: null,
  cloudJobsPerDay: 10
}

export const PRO_PLAN_LIMITS: ErisPlanLimits = {
  dailyRequests: null,
  dailyTokens: null,
  cloudJobsPerDay: null
}

export function normalizeErisPlanId(raw: unknown): ErisPlanId {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
  if (v === 'pro' || v === 'premium' || v === 'unlimited' || v === 'paid') return 'pro'
  return 'free'
}

export function parseErisPlanFromProfile(
  profile: ErisPlanProfileFields | null | undefined
): { plan: ErisPlanId; limits: ErisPlanLimits } {
  const plan = normalizeErisPlanId(
    profile?.erisPlan ?? profile?.plan ?? profile?.eris_plan ?? 'free'
  )
  if (plan === 'pro') {
    return { plan, limits: { ...PRO_PLAN_LIMITS } }
  }
  const overrides = profile?.erisLimits || profile?.eris_limits || null
  const limits: ErisPlanLimits = { ...FREE_PLAN_LIMITS }
  if (overrides && typeof overrides === 'object') {
    if (overrides.dailyRequests != null && Number.isFinite(Number(overrides.dailyRequests))) {
      limits.dailyRequests = Math.max(0, Math.round(Number(overrides.dailyRequests)))
    }
    if (overrides.dailyTokens != null && Number.isFinite(Number(overrides.dailyTokens))) {
      limits.dailyTokens = Math.max(0, Math.round(Number(overrides.dailyTokens)))
    }
    if (
      overrides.cloudJobsPerDay != null &&
      Number.isFinite(Number(overrides.cloudJobsPerDay))
    ) {
      limits.cloudJobsPerDay = Math.max(0, Math.round(Number(overrides.cloudJobsPerDay)))
    }
  }
  return { plan, limits }
}

export function erisPlanLabel(plan: ErisPlanId): string {
  return plan === 'pro' ? 'Pro' : 'Free'
}

export function erisUpgradeUrl(apiBase: string): string {
  const base = (apiBase || 'https://www.ericservic.es').replace(/\/+$/, '')
  return `${base}/account/eris.php?upgrade=pro`
}

export function erisAccountUrl(apiBase: string): string {
  const base = (apiBase || 'https://www.ericservic.es').replace(/\/+$/, '')
  return `${base}/account/eris.php`
}

export type UsageLimitMeter = {
  used: number
  limit: number | null
  remaining: number | null
  ratio: number
  exhausted: boolean
}

export function meterAgainstLimit(used: number, limit: number | null): UsageLimitMeter {
  if (limit == null) {
    return { used, limit: null, remaining: null, ratio: 0, exhausted: false }
  }
  const remaining = Math.max(0, limit - used)
  const ratio = limit <= 0 ? 1 : Math.min(1, used / limit)
  return { used, limit, remaining, ratio, exhausted: used >= limit }
}

/** Instant status-bar plan from saved settings — no network. */
export function previewPlanLabel(plan: string | undefined, linked: boolean): {
  plan: ErisPlanId
  planLabel: string
  limits: ErisPlanLimits
  linked: boolean
} {
  const id = linked ? normalizeErisPlanId(plan) : 'free'
  return {
    plan: id,
    planLabel: id === 'pro' ? 'Pro' : 'Free',
    limits: id === 'pro' ? { ...PRO_PLAN_LIMITS } : { ...FREE_PLAN_LIMITS },
    linked
  }
}
