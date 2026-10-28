import type { TaskContract } from './task-contract'
export interface ScenarioTurn {
  id: string
  prompt: string
  heldout: string
  obligations: string[]
  noEdit?: boolean
  noRun?: boolean
  recommendations?: Array<{ id: string; file: string; function: string; cases: [number, number][] }>
}
export interface ScenarioFamily {
  id: string
  stratum: string
  fixture: Record<string, string> | null
  turns: ScenarioTurn[]
  fault?: string
}
export interface ScenarioResult {
  answer: string
  completion: string
  files?: Record<string, string>
  task?: TaskContract
  calls?: number
  route?: unknown
  applicability?: unknown
  execution?: { state: string; reason?: string }
  elapsedMs?: number
  firstTokenMs?: number | null
  coldLoadMs?: number | null
  outputTokens?: number | null
  faultEvidence?: unknown
  effectiveSettings?: unknown
  requests?: unknown
  events?: string[]
}
export interface ScenarioAdapter {
  kind: 'scripted' | 'live'
  callsPerTurn: number
  start(input: {
    family: ScenarioFamily
    model: string
    repeat: number
    seed: string
    signal: AbortSignal
  }): Promise<{
    turn(input: {
      turn: ScenarioTurn
      index: number
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      priorTask: TaskContract | null
      maxCalls: number
      maxOutputTokens: number
      signal: AbortSignal
    }): Promise<ScenarioResult>
    close(): Promise<void>
  }>
}
export interface ScenarioOptions {
  pack: { version: string; families: ScenarioFamily[] }
  models: string[]
  repeats?: number
  maxCalls: number
  maxOutputTokens: number
  timeoutMs?: number
  seed?: string
  split?: string
  adapter: ScenarioAdapter
  live?: boolean
  signal?: AbortSignal
  adjudications?: Record<string, unknown>
}
