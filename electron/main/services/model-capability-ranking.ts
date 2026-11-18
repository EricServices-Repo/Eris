import families from '../../../resources/model-families.json'
import { usesModelMaximum, parameterBillions, type ModelCapabilityEvidence, type ModelCapabilityProfile } from '../../../src/shared/model-capability-profile'
import { boundedContextWindow, validContextWindow } from '../../../src/shared/model-context'
import type { AppSettings, LocalModelStatus, ModelConnection } from '../../../src/shared/settings-schema'
import { providerModelId } from '../../../src/shared/eris-cloud'
import { isOllamaConnection, ollamaCapabilityEvidence } from './ollama-runtime'
import { providerCapabilityEvidence } from './provider-context'

const knownFamilies = families.map(({ pattern, ...facts }) => ({
  pattern: new RegExp(pattern, 'i'),
  facts: facts as ModelCapabilityEvidence
}))

export const TIER_WEIGHT = { small: 10, standard: 30, strong: 60, frontier: 90 }

export function resolveRoutingCapabilityProfile(
  settings: AppSettings,
  model: string,
  options: { local: boolean; gguf?: LocalModelStatus; connection?: ModelConnection }
): ModelCapabilityProfile {
  const { local, gguf, connection } = options
  const id = providerModelId(model)
  const user = settings.models.capabilityProfiles?.[model]
  const provider = connection && {
    ...providerCapabilityEvidence(connection.baseUrl, id),
    ...(isOllamaConnection(connection) ? ollamaCapabilityEvidence(connection, model) : undefined)
  }
  const known = knownFamilies.find((family) => family.pattern.test(id))?.facts
  const parameters = provider?.parametersBillions ?? parameterBillions(gguf?.parameters) ??
    parameterBillions(id.match(/(?:^|[-: ])(\d+(?:\.\d+)?[bm])(?:$|[-: ])/i)?.[1])
  const size = gguf?.approxBytes
  const tier = parameters !== undefined
    ? parameters < 4 ? 'small' : parameters < 20 ? 'standard' : 'strong'
    : size && size < 2.5 * 1024 ** 3 ? 'small' : size && size >= 16 * 1024 ** 3 ? 'strong' : 'standard'
  const fallback: ModelCapabilityProfile = {
    tier,
    toolCalling: gguf?.routingCapabilities?.tools === false ? 'none' : 'text',
    contextWindow: validContextWindow(gguf?.contextWindow) ? gguf.contextWindow : boundedContextWindow(settings.models.contextWindow),
    reasoning: false,
    vision: false,
    costClass: local ? 'free-local' : 'high'
  }
  return {
    ...fallback,
    ...known,
    ...provider,
    ...(local ? { costClass: 'free-local' } : {}),
    ...(connection?.modelLimits?.[id] ? { contextWindow: connection.modelLimits[id].contextWindow } : {}),
    ...(user?.enabled === false ? undefined : user),
    ...(usesModelMaximum(settings, model) && connection && isOllamaConnection(connection)
      ? { contextWindow: provider?.contextWindow ?? fallback.contextWindow }
      : {})
  }
}

export function formatRoutingCapabilities(profile: ModelCapabilityProfile): string {
  const context = profile.contextWindow >= 1024
    ? `${Math.round(profile.contextWindow / 1024)}k context`
    : `${profile.contextWindow} context`
  const tools = profile.toolCalling === 'none' ? 'no tool calling' : `${profile.toolCalling} tools`
  return `${profile.tier} · ${tools} · ${context} · ${profile.costClass}`
}
