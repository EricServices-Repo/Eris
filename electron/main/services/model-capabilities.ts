import type { AppSettings } from '../../../src/shared/settings-schema'
import { findBuiltinEntry, isBuiltinRef, isNativeGgufRef } from './builtin-model'
import { contextLimits, REPLY_MAX_TOKENS } from './vram-fit'
import { toolProtocolFor } from './tool-protocol'
export interface ModelCapabilities {
  model: string
  requestedContext: number
  contextCeiling: number
  promptBudget: number
  outputCap: number
  outputReserve: number
  contextSource: 'configured-ceiling'
  tools: 'native-tools' | 'text-tools'
  jsonSchema: 'grammar' | 'unverified'
  tokenCounting: 'native-tokenizer' | 'character-estimate'
}
/** Configured ceilings are distinct from the native worker's measured allocation. */
export function resolveModelCapabilities(settings: AppSettings, model: string): ModelCapabilities {
  const requestedContext = settings.models.contextWindow || 32768
  const entry = isBuiltinRef(model) ? findBuiltinEntry(model) : undefined
  const contextCeiling = isBuiltinRef(model)
    ? contextLimits({
        tier: entry?.tier,
        role: entry?.role,
        modelContext: entry?.contextWindow,
        settingsContext: requestedContext
      }).max
    : Math.min(128000, Math.max(512, requestedContext))
  const native = isNativeGgufRef(model)
  const outputReserve = Math.max(
    128,
    Math.min(native ? REPLY_MAX_TOKENS : 16384, Math.floor(contextCeiling * 0.3))
  )
  return {
    model,
    requestedContext,
    contextCeiling,
    promptBudget: Math.floor(contextCeiling * 0.65),
    outputCap: native ? REPLY_MAX_TOKENS : outputReserve,
    outputReserve,
    contextSource: 'configured-ceiling',
    tools: toolProtocolFor(settings, model),
    jsonSchema: native ? 'grammar' : 'unverified',
    tokenCounting: native ? 'native-tokenizer' : 'character-estimate'
  }
}
