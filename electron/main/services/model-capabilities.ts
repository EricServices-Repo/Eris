import type { AppSettings } from '../../../src/shared/settings-schema'
import { contextPlan, findBuiltinEntry, isBuiltinRef, isNativeGgufRef } from './builtin-model'
import { lastGpuAccelStatus } from './gpu-accel'
import { findLocalEntry, isLocalRef, localEntryAsBuiltin } from './local-model'
import { loadedModelFacts } from './model-runtime'
import { serverWindow, serverWindowFacts } from './ollama-runtime'
import { contextLimits, REPLY_MAX_TOKENS } from './vram-fit'
import { toolProtocolFor } from './tool-protocol'
export interface ModelCapabilities {
  model: string
  requestedContext: number
  contextCeiling: number
  promptBudget: number
  outputCap: number
  outputReserve: number
  /** measured-allocation > runtime-plan > unverified-window > configured-ceiling. */
  contextSource: 'measured-allocation' | 'runtime-plan' | 'unverified-window' | 'configured-ceiling'
  tools: 'native-tools' | 'text-tools'
  jsonSchema: 'grammar' | 'unverified'
  /** How a compile counts right now: only a resident model can tokenize. */
  tokenCounting: 'native-tokenizer' | 'character-estimate'
}
export function nativeEntry(model: string) {
  if (isBuiltinRef(model)) return findBuiltinEntry(model)
  if (!isLocalRef(model)) return null
  const local = findLocalEntry(model)
  return local && localEntryAsBuiltin(local)
}
/** The best available capacity: what was allocated, else what a load would ask for. */
function contextCapacity(settings: AppSettings, model: string, requestedContext: number) {
  const entry = nativeEntry(model)
  const measured = entry && loadedModelFacts(entry.ref)
  if (measured)
    return { contextCeiling: measured.contextSize, contextSource: 'measured-allocation' as const }
  if (entry)
    return {
      contextCeiling: contextPlan(entry, lastGpuAccelStatus()?.vramBudgetBytes, requestedContext)
        .max,
      contextSource: 'runtime-plan' as const
    }
  const served = serverWindow(settings, model, requestedContext)
  if (served) return served
  return {
    contextCeiling: isBuiltinRef(model)
      ? contextLimits({ settingsContext: requestedContext }).max
      : Math.min(128000, Math.max(512, requestedContext)),
    contextSource: 'configured-ceiling' as const
  }
}
/** Recorded with each compile, so a report can tell a measurement from a plan. */
export function contextProvenance(settings: AppSettings, model: string) {
  const { contextCeiling, contextSource } = resolveModelCapabilities(settings, model)
  const entry = nativeEntry(model)
  const measured = entry ? loadedModelFacts(entry.ref) : null
  return {
    source: contextSource,
    tokens: contextCeiling,
    ...(measured
      ? {
          gpuLayers: measured.gpuLayers,
          totalLayers: measured.totalLayers,
          kvBytes: measured.kvBytes,
          device: measured.device,
          placementSteps: measured.placementSteps
        }
      : {}),
    ...serverWindowFacts(settings, model)
  }
}
/** Budgets follow the allocation; settings and the model card only bound what is requested. */
export function resolveModelCapabilities(settings: AppSettings, model: string): ModelCapabilities {
  const requestedContext = settings.models.contextWindow || 32768
  const { contextCeiling, contextSource } = contextCapacity(settings, model, requestedContext)
  const native = isNativeGgufRef(model)
  const entry = nativeEntry(model)
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
    contextSource,
    tools: toolProtocolFor(settings, model),
    jsonSchema: native ? 'grammar' : 'unverified',
    tokenCounting: entry && loadedModelFacts(entry.ref) ? 'native-tokenizer' : 'character-estimate'
  }
}
