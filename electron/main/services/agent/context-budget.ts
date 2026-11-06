import type { AppSettings } from '../../../../src/shared/settings-schema'
import { isNativeGgufRef, warmLocalInference } from '../builtin-model'
import { activeDiagnosticsScope, assertProviderCallAllowed } from '../model-transport'
import { reportChatActivity } from '../chat-activity'
import { resolveModelCapabilities } from '../model-capabilities'
/** Prompt compaction and transport compilation consume the same configured ceiling. */
export function contextBudgetTokens(settings: AppSettings, workerModel: string): number {
  return resolveModelCapabilities(settings, workerModel).promptBudget
}

/** Acquire measured native capacity before selecting or discarding prompt material. */
export async function prepareContextBudget(
  settings: AppSettings,
  model: string,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted()
  const capabilities = resolveModelCapabilities(settings, model)
  if (
    !isNativeGgufRef(model) ||
    capabilities.contextSource === 'measured-allocation' ||
    activeDiagnosticsScope()?.adapter.kind === 'scripted'
  )
    return capabilities.promptBudget
  assertProviderCallAllowed(settings, model)
  reportChatActivity('loading', {
    source: 'transport',
    purpose: 'agent',
    model,
    reason: 'Allocating local context before packing the prompt'
  })
  const result = await warmLocalInference(settings, model, signal, {
    contextWindow: capabilities.requestedContext
  })
  signal?.throwIfAborted()
  if (process.env.VITEST && result.error === 'skipped') return capabilities.promptBudget
  const measured = resolveModelCapabilities(settings, model)
  if (!result.ok || measured.contextSource !== 'measured-allocation')
    throw new Error(
      `Cannot prepare ${model}: ${result.error || 'the local runtime did not report an allocated context window'}`
    )
  return measured.promptBudget
}
