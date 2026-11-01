import type { AppSettings, TurnPlan } from '../../../../src/shared/settings-schema'
import { chooseExecutionModel } from '../auto-model-policy'
import { isNativeGgufRef, warmLocalInference } from '../builtin-model'
import { activeDiagnosticsScope, assertProviderCallAllowed } from '../model-transport'
import { prepareModelWindows } from '../ollama-runtime'
import { resolveModelCapabilities } from '../model-capabilities'

const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
}
/**
 * Called only between completed model streams/tool batches. Native preparation uses
 * the existing exclusive inference scheduler and serialized load/dispose gate; it
 * never starts a second parallel resident model. Callers commit a plan only after
 * this succeeds, then rebuild prompts using the measured target allocation.
 */
export async function prepareModelTransition(options: {
  settings: AppSettings
  plan: TurnPlan
  from: string
  to: string
  releaseSession: () => void
  getSecret: (key: string) => string | null
  signal?: AbortSignal
}): Promise<number> {
  checkAbort(options.signal)
  if (options.from === options.to)
    return resolveModelCapabilities(options.settings, options.to).promptBudget
  if (!options.plan.modelExecution || options.plan.modelExecution.policy === 'fixed')
    throw new Error('Fixed model selection does not permit an automatic model switch')
  const choice = await chooseExecutionModel(
    options.settings,
    options.plan.intent,
    options.plan.modelExecution.policy
  )
  if (!choice.candidates.some((c) => c.model === options.to && c.eligible))
    throw new Error(
      `Model transition refused: ${options.to} is no longer eligible. ${choice.candidates.map((c) => `${c.model}: ${c.reason}`).join('; ')}`
    )
  checkAbort(options.signal)
  options.releaseSession()
  // Scripted transports must never cause real model loads or provider traffic.
  if (activeDiagnosticsScope()?.adapter.kind !== 'scripted') {
    assertProviderCallAllowed(options.settings, options.to)
    if (isNativeGgufRef(options.to)) {
      const result = await warmLocalInference(options.settings, options.to, options.signal)
      if (!result.ok)
        throw new Error(
          `Cannot prepare ${options.to}: ${result.error || 'resource admission failed'}`
        )
    } else {
      await prepareModelWindows(options.settings, [options.to], options.getSecret, options.signal)
    }
  }
  checkAbort(options.signal)
  return resolveModelCapabilities(options.settings, options.to).promptBudget
}

/** Refusals are not evidence that another model should bypass a permission or safety decision. */
export function prohibitsModelRecovery(text: string): boolean {
  return /approval.denied|permission.denied|user denied|not authorized|not permitted|unsafe|safety policy|content.filter|cannot (?:assist|help)|can't (?:assist|help)|i must refuse/i.test(
    text
  )
}
