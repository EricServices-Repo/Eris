import type { AppSettings, ChatIntent } from '../../../src/shared/settings-schema'
import { isExactBuiltinReady } from './builtin-model'
import { getLocalStatuses } from './local-model'
import { modelDestination } from './model-destination'
import { currentLoadedModel } from './model-runtime'
import { CONTEXT_HEADROOM_BYTES, inferenceBudgetBytes } from './vram-fit'

export type ExecutionPolicy = 'fixed' | 'auto-local' | 'auto-any'
export type ModelCandidate = {
  model: string
  eligible: boolean
  reason: string
  rank: number
  locality: string
}
export type AutoModelChoice = {
  model: string
  basis: 'telemetry' | 'eval' | 'profile'
  policy: ExecutionPolicy
  candidates: ModelCandidate[]
}
export function executionPolicy(settings: AppSettings, selected: string): ExecutionPolicy {
  if (selected === 'auto-local') return 'auto-local'
  if (selected === 'auto-any') return 'auto-any'
  if (selected.trim() && selected !== 'auto') return 'fixed'
  return settings.agent.routing.profile === 'local' || !settings.agent.routing.preferCloudComposer
    ? 'auto-local'
    : 'auto-any'
}

/** Execution locality is stricter than permission to disclose recall to an approved LAN host. */
export function executionLocal(settings: AppSettings, model: string): boolean {
  if (model === 'builtin:composer')
    return settings.agent.routing.useLocalComposerFull === true && isExactBuiltinReady(model)
  return modelDestination(settings, model).locality !== 'remote'
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
  options: { cloudComposer?: boolean } = {}
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
  const add = (model: string, ready: boolean, reason: string, rank: number) => {
    if (seen.has(model)) return
    seen.add(model)
    const local = executionLocal(settings, model)
    if (!ready) reason = reason || 'not ready'
    else if (excluded.includes(model)) reason = 'already attempted in this run'
    else if (policy === 'auto-local' && !local) reason = 'excluded by Auto-local execution policy'
    candidates.push({
      model,
      eligible: ready && !reason,
      reason: reason || 'eligible; heuristic fallback',
      locality: local ? 'local' : 'remote',
      rank: rank + (resident?.ref === model ? 3 : 0)
    })
  }
  add('builtin:composer-lite', isExactBuiltinReady('builtin:composer-lite'), '', 10)
  const fullLocal =
    settings.agent.routing.useLocalComposerFull && isExactBuiltinReady('builtin:composer')
  // Cloud Composer is resolved separately by the production cloud route.
  add(
    'builtin:composer',
    Boolean(fullLocal) || (policy === 'auto-any' && options.cloudComposer === true),
    '',
    ['edit', 'verify', 'run'].includes(intent) ? 24 : 8
  )
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
    const requiresTools = !['answer', 'capability'].includes(intent)
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
    add(m.ref, m.ready, reason, 20 + specialization)
  }
  for (const c of settings.models.connections) {
    if (!c.enabled || c.type === 'builtin') continue
    for (const model of c.models.filter((m) => m.trim() && !/^(local:|builtin:)/.test(m))) {
      add(model, true, /embed|mmproj|clip|encoder/i.test(model) ? 'non-chat model' : '', 18)
    }
  }
  const eligible = candidates
    .filter((c) => c.eligible)
    .sort((a, b) => b.rank - a.rank || a.model.localeCompare(b.model))
  for (const c of eligible)
    c.reason = `eligible; heuristic task rank ${c.rank}; ${
      resident?.ref === c.model
        ? 'measured resident context, no reload'
        : 'switch/load cost estimated; capability specialization inferred unless declared'
    }`
  const refs = eligible.map((c) => c.model)
  if (settings.evals?.useScoresForRouting && refs.length) {
    const { bestModelForIntent } = await import('./agent-telemetry')
    const measured = bestModelForIntent(intent, refs, settings.evals.minRuns, settings)
    if (measured && refs.includes(measured))
      return { model: measured, basis: 'telemetry', policy, candidates }
    const { bestEvalModelForIntent } = await import('./eval-store')
    const evaluated = bestEvalModelForIntent(
      intent,
      refs,
      settings.evals.minRuns,
      undefined,
      settings
    )
    if (evaluated && refs.includes(evaluated))
      return { model: evaluated, basis: 'eval', policy, candidates }
  }
  return { model: eligible[0]?.model || '', basis: 'profile', policy, candidates }
}
