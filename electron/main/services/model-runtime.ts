import type { PlacementStep } from './vram-fit'
/** What the native runtime actually allocated. Only one model is resident at a time. */
export interface LoadedModelFacts {
  ref: string
  contextSize: number
  trainContextSize?: number
  gpuLayers?: number
  totalLayers?: number
  /** Estimated KV bytes for the allocated window, from the runtime's own estimate. */
  kvBytes?: number
  device?: string
  /** Why this window: each ladder step tried, in order. */
  placementSteps?: PlacementStep[]
}
let loaded: LoadedModelFacts | null = null

export function recordLoadedModel(facts: LoadedModelFacts) {
  loaded = facts.contextSize > 0 ? facts : null
}
export function clearLoadedModel() {
  loaded = null
}
/** What is resident now, for status surfaces that do not know a model ref. */
export const currentLoadedModel = () => loaded
export function loadedModelFacts(ref: string): LoadedModelFacts | null {
  return loaded?.ref === ref ? loaded : null
}
