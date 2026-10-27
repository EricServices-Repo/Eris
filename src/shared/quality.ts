export interface QualityCase {
  id: string
  stratum: string
  prompt: string
  project: Record<string, string> | null
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  fault?: string
  oracle: string
  expected?: unknown
  obligations: string[]
}
export interface QualityPack {
  version: string
  cases: QualityCase[]
}
export interface QualityResult {
  answer: string
  completion: string
  effectiveSettings: Record<string, unknown>
  calls?: number
  observed?: Record<string, unknown>
  usage?: { outputTokens?: number; inputTokens?: number; source?: string }
}
export interface QualityAdapter {
  kind: 'scripted' | 'live'
  callsPerInvocation?: number
  run(input: {
    test: QualityCase
    model: string
    repeat: number
    maxCalls: number
    maxOutputTokens: number
    signal: AbortSignal
  }): Promise<QualityResult>
}
export interface QualityReport {
  version: number
  packVersion: string
  packDigest: string
  mode: string
  calls: number
  models: string[]
  repeats: number
  rows: Array<{
    key: string
    caseId: string
    status: string
    result?: QualityResult
    resultDigest?: string
    correctness?: { state: string }
    [key: string]: unknown
  }>
  [key: string]: unknown
}
export interface QualityInput {
  models: string[]
  context: number
  repeats: number
  maxCalls: number
  maxOutputTokens: number
  live: true
}
export interface QualitySummary {
  path: string
  observed: number
  unresolved: number
  skipped: number
}
