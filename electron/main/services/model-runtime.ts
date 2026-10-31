/** What the native runtime actually allocated. Only one model is resident at a time. */
export interface LoadedModelFacts {
  ref: string
  contextSize: number
  trainContextSize?: number
  gpuLayers?: number
  totalLayers?: number
}
let loaded: LoadedModelFacts | null = null

export function recordLoadedModel(facts: LoadedModelFacts) {
  loaded = facts.contextSize > 0 ? facts : null
}
export function clearLoadedModel() {
  loaded = null
}
export function loadedModelFacts(ref: string): LoadedModelFacts | null {
  return loaded?.ref === ref ? loaded : null
}
