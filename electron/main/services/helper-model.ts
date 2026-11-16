import type { AppSettings, TurnPlan } from '../../../src/shared/settings-schema'
import { isNativeGgufRef } from '../../../src/shared/model-destination'
import { executionLocal, workspaceLocalityViolation } from './auto-model-policy'
import { activeDiagnosticsScope } from './model-transport'
import { currentLoadedModel } from './model-runtime'

export function helperModel(
  settings: AppSettings,
  plan: Pick<TurnPlan, 'intent' | 'models' | 'modelExecution'>,
  purpose: 'route' | 'resolve' | 'outcome' | 'compact'
): string | undefined {
  const preference = settings.agent?.helperCalls ?? 'fast'
  if (preference === 'off') return undefined

  const worker = plan.models.tools || plan.models.chat
  const primary = plan.models.primary || worker
  const strongReview = purpose === 'outcome' && ['review', 'verify'].includes(plan.intent)
  const preferred = plan.modelExecution?.policy === 'fixed' ? worker
    : preference === 'primary' || strongReview ? primary : plan.models.fast || primary
  const allowed = (model: string) =>
    Boolean(model) && !workspaceLocalityViolation(settings, model) &&
    (plan.modelExecution?.policy !== 'auto-local' || executionLocal(settings, model))

  let model = allowed(preferred) ? preferred : worker
  // Do not send local work to a remote helper.
  if (worker && executionLocal(settings, worker) && !executionLocal(settings, model)) model = worker
  if (!allowed(model)) return undefined

  if (isNativeGgufRef(model) && !activeDiagnosticsScope()) {
    const resident = currentLoadedModel()?.ref
    // Reuse the resident native worker or skip optional inference before a cold load.
    return resident && isNativeGgufRef(resident) && allowed(resident) &&
      (plan.modelExecution?.policy !== 'fixed' || resident === model) ? resident : undefined
  }
  return model
}
