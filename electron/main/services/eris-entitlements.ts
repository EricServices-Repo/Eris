import type { AppSettings } from '../../../src/shared/settings-schema'
import {
  FREE_PLAN_LIMITS,
  PRO_PLAN_LIMITS,
  erisAccountUrl,
  erisPlanLabel,
  erisUpgradeUrl,
  meterAgainstLimit,
  type ErisPlanId,
  type ErisPlanLimits,
  type UsageLimitMeter
} from '../../../src/shared/eris-plan'
import { getUsageSnapshot } from './usage-stats'
import { isEricServicesAuthenticated } from './ericservices'

export type UsageEntitlement = {
  plan: ErisPlanId
  planLabel: string
  authenticated: boolean
  limits: ErisPlanLimits
  requests: UsageLimitMeter
  tokens: UsageLimitMeter
  cloudJobs: UsageLimitMeter
  overLimit: boolean
  blockedReason: string | null
  upgradeUrl: string
  accountUrl: string
}

export function resolvePlanLimits(settings: AppSettings): {
  plan: ErisPlanId
  limits: ErisPlanLimits
} {
  const plan: ErisPlanId = settings.ericServices?.plan === 'pro' ? 'pro' : 'free'
  if (plan === 'pro') return { plan, limits: { ...PRO_PLAN_LIMITS } }

  const overrides = settings.ericServices?.planLimits || {}
  return {
    plan,
    limits: {
      dailyRequests:
        overrides.dailyRequests !== undefined && overrides.dailyRequests !== null
          ? overrides.dailyRequests
          : FREE_PLAN_LIMITS.dailyRequests,
      dailyTokens:
        overrides.dailyTokens !== undefined && overrides.dailyTokens !== null
          ? overrides.dailyTokens
          : FREE_PLAN_LIMITS.dailyTokens,
      cloudJobsPerDay:
        overrides.cloudJobsPerDay !== undefined && overrides.cloudJobsPerDay !== null
          ? overrides.cloudJobsPerDay
          : FREE_PLAN_LIMITS.cloudJobsPerDay
    }
  }
}

export function getUsageEntitlement(
  settings: AppSettings,
  getSecret: (key: string) => string | null
): UsageEntitlement {
  const token = settings.ericServices.tokenRef
    ? getSecret(settings.ericServices.tokenRef)
    : null
  const authenticated = isEricServicesAuthenticated(settings, token)
  const { plan, limits } = resolvePlanLimits(settings)
  const snap = getUsageSnapshot(1)
  const usedRequests = snap.today.totalRequests
  const usedTokens = snap.today.totalInputTokens + snap.today.totalOutputTokens
  const usedCloud = snap.today.cloudJobs || 0

  const requests = meterAgainstLimit(usedRequests, limits.dailyRequests)
  const tokens = meterAgainstLimit(usedTokens, limits.dailyTokens)
  const cloudJobs = meterAgainstLimit(usedCloud, limits.cloudJobsPerDay)

  let blockedReason: string | null = null
  if (plan === 'free') {
    if (requests.exhausted) {
      blockedReason = `Free plan daily request limit reached (${limits.dailyRequests}). Upgrade to Pro for unlimited usage.`
    } else if (tokens.exhausted) {
      blockedReason = `Free plan daily token limit reached (${limits.dailyTokens}). Upgrade to Pro for unlimited usage.`
    }
  }

  return {
    plan,
    planLabel: erisPlanLabel(plan),
    authenticated,
    limits,
    requests,
    tokens,
    cloudJobs,
    overLimit: Boolean(blockedReason),
    blockedReason,
    upgradeUrl: erisUpgradeUrl(settings.ericServices.apiBase),
    accountUrl: erisAccountUrl(settings.ericServices.apiBase)
  }
}

export function assertChatWithinPlan(
  settings: AppSettings,
  getSecret: (key: string) => string | null
): void {
  const ent = getUsageEntitlement(settings, getSecret)
  if (ent.blockedReason) throw new Error(ent.blockedReason)
}

export function assertCloudJobWithinPlan(
  settings: AppSettings,
  getSecret: (key: string) => string | null
): void {
  const ent = getUsageEntitlement(settings, getSecret)
  if (ent.plan === 'pro') return
  if (ent.cloudJobs.exhausted) {
    throw new Error(
      `Free plan daily Cloud Agent limit reached (${ent.limits.cloudJobsPerDay}). Upgrade to Pro for unlimited Cloud Agents.`
    )
  }
  if (ent.blockedReason) throw new Error(ent.blockedReason)
}
