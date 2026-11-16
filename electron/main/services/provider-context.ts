import { parameterBillions, type ModelCapabilityEvidence } from '../../../src/shared/model-capability-profile'
import { boundedContextWindow, validContextWindow } from '../../../src/shared/model-context'

type ProviderModelFacts = ModelCapabilityEvidence & { maxOutputTokens?: number }

/** Facts from a model-list refresh, never guessed from an ID or shared across endpoints. */
const catalogs = new Map<
  string,
  { at: number; models: Map<string, ProviderModelFacts> }
>()
const endpoint = (url: string) => url.replace(/\/$/, '')
const TTL_MS = 5 * 60_000

export function recordProviderContexts(baseUrl: string, rows: unknown[]): void {
  const models = new Map<string, ProviderModelFacts>()
  for (const row of rows.slice(0, 4096)) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const top = item.top_provider as Record<string, unknown> | undefined
    const window =
      item.context_length ?? item.max_model_len ?? item.context_window ?? top?.context_length
    if (typeof item.id !== 'string' || !item.id || item.id.length > 512) continue
    const supported = Array.isArray(item.supported_parameters) ? item.supported_parameters : null
    const architecture = item.architecture as { input_modalities?: unknown } | undefined
    const modalities = architecture?.input_modalities
    const pricing = item.pricing as { prompt?: unknown; completion?: unknown } | undefined
    const prices = [pricing?.prompt, pricing?.completion].map((value) =>
      (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN
    )
    const costClass = prices.every((value) => Number.isFinite(value) && value >= 0)
      ? (Math.max(...prices) <= 5 / 1e6 ? 'low' : 'high')
      : undefined
    const parametersBillions = parameterBillions(item.parameter_count)
    const contextWindow = validContextWindow(window) ? boundedContextWindow(window) : undefined
    const output = item.max_output_tokens ?? top?.max_completion_tokens
    models.set(item.id, {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(supported?.includes('tools') ? { toolCalling: 'native' } : {}),
      ...(supported ? { reasoning: supported.includes('reasoning') || supported.includes('include_reasoning') } : {}),
      ...(Array.isArray(modalities) ? { vision: modalities.includes('image') } : {}),
      ...(costClass ? { costClass } : {}),
      ...(parametersBillions === undefined ? {} : { parametersBillions }),
      ...(typeof output === 'number' &&
      Number.isSafeInteger(output) &&
      output >= 128 &&
      contextWindow !== undefined && output <= contextWindow
        ? { maxOutputTokens: output }
        : {})
    })
  }
  const key = endpoint(baseUrl)
  if (catalogs.size >= 32 && !catalogs.has(key)) catalogs.delete(catalogs.keys().next().value!)
  catalogs.set(key, { at: Date.now(), models })
}

export function providerCapabilityEvidence(baseUrl: string, model: string) {
  const facts = catalogs.get(endpoint(baseUrl))
  if (!facts || Date.now() - facts.at > TTL_MS) return undefined
  return facts.models.get(model)
}


export function providerContext(baseUrl: string, model: string) {
  const facts = providerCapabilityEvidence(baseUrl, model)
  if (facts?.contextWindow === undefined) return undefined
  return { contextWindow: facts.contextWindow, ...(facts.maxOutputTokens ? { maxOutputTokens: facts.maxOutputTokens } : {}) }
}
