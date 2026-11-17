import { estimatedNativeAnswerMs } from './model-latency'
import { isNativeGgufRef } from '../../../src/shared/model-destination'
import { connectionModelRef } from '../../../src/shared/eris-cloud'
import type { AppSettings, ChatIntent, LocalModelStatus, ModelConnection } from '../../../src/shared/settings-schema'
import { getSecret } from './credentials'
import { getLocalStatuses } from './local-model'
import { modelDestination } from './model-destination'
import { formatRoutingCapabilities, resolveRoutingCapabilityProfile, TIER_WEIGHT } from './model-capability-ranking'
import { currentLoadedModel } from './model-runtime'
import { CONTEXT_HEADROOM_BYTES, inferenceBudgetBytes } from './vram-fit'

// Avoid a model reload for small heuristic differences; measured quality still wins.
export const SWITCH_MARGIN = 10

export type ExecutionPolicy = 'fixed' | 'auto-local' | 'auto-any'
export type ModelCandidate = {
  model: string
  eligible: boolean
  reason: string
  rank: number
  locality: string
  estimatedAnswerMs?: number
  capabilities?: string
}
export type AutoModelChoice = {
  model: string
  basis: 'telemetry' | 'eval' | 'profile'
  policy: ExecutionPolicy
  candidates: ModelCandidate[]
}
export function executionPolicy(settings: AppSettings, selected: string): ExecutionPolicy {
  if (selected.trim() && !['auto', 'auto-local', 'auto-any'].includes(selected)) return 'fixed'
  if (selected === 'auto-local' || settings.agent.routing.profile === 'local') return 'auto-local'
  if (selected === 'auto-any') return 'auto-any'
  return settings.models.defaultModel === 'auto-local' ? 'auto-local' : 'auto-any'
}

/** Execution locality is stricter than permission to disclose recall to an approved LAN host. */
export function executionLocal(settings: AppSettings, model: string): boolean {
  return modelDestination(settings, model).locality !== 'remote'
}

/** Why a model may not run under this workspace's local-only ceiling, or undefined if it may. */
export function workspaceLocalityViolation(settings: AppSettings, model: string): string | undefined {
  if (settings.agent?.routing?.workspaceLocalOnly !== true || !model.trim()) return undefined
  if (['auto', 'auto-local', 'auto-any'].includes(model) || executionLocal(settings, model)) return undefined
  return `This workspace is limited to models on this computer (.eris/settings.json), so ${model} cannot be used. Choose a local model or Auto (this computer only).`
}

function secretPresent(ref: string): boolean {
  try {
    return Boolean(getSecret(ref)?.trim())
  } catch {
    return false // an unreadable credential store cannot authenticate a request either
  }
}

/** Inventory-only admission. GPU fit and intent requirements are checked after intake. */
export function hasAutoModelInventory(settings: AppSettings, policy: ExecutionPolicy): boolean {
  if (getLocalStatuses().some((model) => model.ready)) return true
  return settings.models.connections.some((connection) =>
    connection.enabled && connection.type === 'openai-compatible' && connection.baseUrl.trim() &&
    (!connection.apiKeyRef || secretPresent(connection.apiKeyRef)) &&
    connection.models.some((name) => name.trim() && !/^(?:local:|builtin:)/.test(name) &&
      (policy !== 'auto-local' || executionLocal(settings, connectionModelRef(connection, name))))
  )
}
/**
 * Rebuilt at every decision; no cached eligibility survives a URL/profile/inventory change.
 * File size is an admission/cost estimate, never evidence of task quality. Name-based
 * specialization is explicitly a heuristic; measured intent outcomes take precedence.
 */
export async function chooseExecutionModel(
  settings: AppSettings,
  intent: ChatIntent,
  selected = 'auto',
  excluded: readonly string[] = [],
  _options: { requiredContext?: number; modelClass?: 'primary' | 'fast' } = {}
): Promise<AutoModelChoice> {
  const policy = executionPolicy(settings, selected)
  if (policy === 'fixed') return { model: selected, policy, basis: 'profile', candidates: [] }
  const locals = getLocalStatuses()
  let budget = 0
  if (locals.some((m) => m.ready)) {
    try {
      const { getGpuAccelStatus } = await import('./gpu-accel')
      const gpu = await getGpuAccelStatus(settings.models.preferEgpu !== false)
      budget = inferenceBudgetBytes({
        vramShareFreeBytes: gpu.vramShareFreeBytes,
        vramShareTotalBytes: gpu.vramShareTotalBytes,
        preferredFreeBytes: gpu.preferredGpu?.vramFreeBytes,
        preferredTotalBytes: gpu.preferredGpu?.vramBytes
      })
    } catch {
      /* unknown capacity excludes cold native workers */
    }
  }
  const resident = currentLoadedModel()
  const candidates: ModelCandidate[] = []
  const seen = new Set<string>()
  const tierWeights = new Map<string, number>()
  const preferenceWeights = new Map<string, number>()
  const requiresTools = !['answer', 'capability'].includes(intent)
  const add = (model: string, ready: boolean, reason: string, specialization: number,
    source: { gguf?: LocalModelStatus; connection?: ModelConnection }) => {
    if (seen.has(model)) return
    seen.add(model)
    const local = executionLocal(settings, model)
    if (!ready) reason = reason || 'not ready'
    else if (excluded.includes(model)) reason = 'already attempted in this run'
    else if (policy === 'auto-local' && !local) reason = 'excluded by Auto-local execution policy'
    const profile = resolveRoutingCapabilityProfile(settings, model, { local, ...source })
    const requiredContext = _options.requiredContext ?? 1024
    if (!reason && requiresTools && profile.toolCalling === 'none') reason = 'capability profile declares no tool calling'
    if (!reason && profile.contextWindow < requiredContext)
      reason = `context window ${profile.contextWindow} below required ${requiredContext} tokens`

    const tierWeight = TIER_WEIGHT[profile.tier]
    const costWeight = { 'free-local': 3, low: 2, high: 0 }[profile.costClass]
    const preference = settings.models.selectionPreference
    const preferenceWeight = preference === 'local' && local ? 1 :
      preference === 'cheapest' ? costWeight : 0
    tierWeights.set(model, tierWeight)
    preferenceWeights.set(model, preferenceWeight)
    const contextFit = Math.min(4, Math.max(0, Math.floor(Math.log2(profile.contextWindow / requiredContext))))
    const toolFit = requiresTools && profile.toolCalling === 'native' ? 5 : 0
    const rank = _options.modelClass === 'fast'
      ? (tierWeight <= TIER_WEIGHT.standard ? 2000 : 0) + costWeight * 100 - tierWeight + toolFit + contextFit
      : tierWeight + specialization + toolFit + contextFit
    candidates.push({
      model,
      eligible: ready && !reason,
      reason,
      locality: local ? 'local' : 'remote',
      rank: rank + 5000 * preferenceWeight,
      capabilities: formatRoutingCapabilities(profile)
    })
  }
  for (const m of locals) {
    const incompatible = /mmproj|embed|clip|vision|encoder/i.test(
      `${m.ref} ${m.name} ${m.filename}`
    )
    const residentFits = resident?.ref === m.ref && resident.contextSize >= 1024
    const fits =
      residentFits || (m.approxBytes > 0 && m.approxBytes + CONTEXT_HEADROOM_BYTES <= budget)
    const coding = /coder|codestral|codeqwen|deepseek.*code/i.test(`${m.name} ${m.ref} ${m.family}`)
    const codeTask = ['edit', 'verify', 'run', 'review', 'explore'].includes(intent)
    const specialization = coding ? (codeTask ? 8 : -2) : codeTask ? 0 : 6
    const declared = m.routingCapabilities
    const unsupported =
      (declared?.intents && !declared.intents.includes(intent)) ||
      (requiresTools && declared?.tools === false)
    const reason = incompatible
      ? 'non-chat model'
      : unsupported
        ? 'declared task/tool incompatibility'
        : m.contextWindow && m.contextWindow < 1024
          ? 'context capacity below minimum'
          : !fits
            ? 'insufficient or unknown memory budget'
            : ''
    add(m.ref, m.ready, reason, specialization, { gguf: m })
  }
  for (const c of settings.models.connections) {
    if (!c.enabled || c.type === 'builtin') continue
    // A connection that names a key but has none stored cannot authenticate: it is not
    // ready, so Auto must not prefer it over a ready worker (#305 MO-03).
    const keyMissing = Boolean(c.apiKeyRef.trim()) && !secretPresent(c.apiKeyRef)
    const baseMissing = !c.baseUrl.trim()
    for (const id of c.models.filter((m) => m.trim() && !/^(local:|builtin:)/.test(m))) {
      const model = connectionModelRef(c, id)
      add(
        model,
        true,
        /embed|mmproj|clip|encoder/i.test(model)
          ? 'non-chat model'
          : baseMissing
            ? 'connection has no base URL'
            : keyMissing
              ? 'connection API key is not stored'
              : '',
        0,
        { connection: c }
      )
    }
  }
  const eligible = candidates
    .filter((c) => c.eligible)
     .sort((a, b) => {
      const priority = (ref: string) => {
        const i = settings.models.priority?.indexOf(ref) ?? -1
        return i < 0 ? Number.MAX_SAFE_INTEGER : i
      }
      return b.rank - a.rank || tierWeights.get(b.model)! - tierWeights.get(a.model)! || priority(a.model) - priority(b.model)
    })
  const preferredWeight = preferenceWeights.get(eligible[0]?.model)
  const refs = eligible.filter((c) => preferenceWeights.get(c.model) === preferredWeight).map((c) => c.model)
  let model = eligible[0]?.model || ''
  let basis: AutoModelChoice['basis'] = 'profile'
  if (settings.evals?.useScoresForRouting && refs.length) {
    const { bestModelForIntent } = await import('./agent-telemetry')
    const measured = bestModelForIntent(intent, refs, settings.evals.minRuns, settings)
    if (measured && refs.includes(measured)) {
      model = measured
      basis = 'telemetry'
    } else {
      const { bestEvalModelForIntent } = await import('./eval-store')
      const evaluated = bestEvalModelForIntent(
        intent,
        refs,
        settings.evals.minRuns,
        undefined,
        settings
      )
      if (evaluated && refs.includes(evaluated)) {
        model = evaluated
        basis = 'eval'
      }
    }
  }
  // Stickiness applies only to eligible residents and heuristic choices. Measured
  // outcomes or eval evidence take precedence over load avoidance.
  let keptResident = false
  const residentCandidate = resident && resident.contextSize >= 1024
    ? eligible.find((candidate) => candidate.model === resident.ref)
    : undefined
  if (basis === 'profile' && residentCandidate && eligible[0] &&
      tierWeights.get(eligible[0].model) === tierWeights.get(residentCandidate.model) &&
      eligible[0].rank - residentCandidate.rank < SWITCH_MARGIN) {
    keptResident = model !== residentCandidate.model
    model = residentCandidate.model
  }
  let usedLatency = false
  if (
    basis === 'profile' &&
    (intent === 'answer' || intent === 'capability') &&
    isNativeGgufRef(model)
  ) {
    for (const candidate of eligible) {
      if (!isNativeGgufRef(candidate.model)) continue
      candidate.estimatedAnswerMs = estimatedNativeAnswerMs(
        settings,
        candidate.model,
        resident?.ref === candidate.model
      )
    }
    const baseline = eligible.find((candidate) => candidate.model === model)!
    // Keep quality scores, fixed selections and workspace tasks outside this
    // tiebreak. Change the decision only when measurements show a material gain.
    let bestMs = baseline.estimatedAnswerMs
    if (bestMs !== undefined) {
      const threshold = bestMs * 0.8
      for (const candidate of eligible) {
        const ms = candidate.estimatedAnswerMs
        if (
          candidate.rank >= baseline.rank - 8 &&
          ms !== undefined &&
          ms < threshold &&
          ms < bestMs
        ) {
          model = candidate.model
          bestMs = ms
          usedLatency = true
        }
      }
    }
  }
  // Record the decision itself: what was chosen, on which evidence, and what beat every
  // other eligible model (#305 MO-03). A measured choice must not read as a rank choice.
  const winner = eligible.find((c) => c.model === model)
  const evidence =
    basis === 'telemetry'
      ? `measured run outcomes for ${intent}`
      : usedLatency
        ? 'measured first-output latency for short answers'
        : basis === 'eval'
          ? `evaluation scores for ${intent}`
          : keptResident && model === residentCandidate?.model
            ? 'eligible resident within switch margin'
            : 'heuristic task rank'
  for (const c of eligible) {
    const cost =
      resident?.ref === c.model
        ? 'measured resident context, no reload'
        : 'switch/load cost estimated; capability specialization inferred unless declared'
    c.reason =
      c === winner
        ? `selected by ${evidence}; heuristic task rank ${c.rank}; ${cost}`
        : `eligible, not selected: ${model} won on ${evidence}${
            basis !== 'profile' || usedLatency
              ? ''
              : winner!.rank === c.rank
                ? ` (tied at ${c.rank}; broken by configured priority or catalog order)`
                : ` (${winner!.rank} vs ${c.rank})`
          }; ${cost}`
  }
  for (const c of eligible) {
    c.reason += `; ${c.capabilities}`
    if (preferenceWeights.get(c.model)) c.reason += ' · preferred by settings'
  }
  return { model, basis, policy, candidates }
}
