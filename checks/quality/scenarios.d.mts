import type {
  ScenarioOptions,
  ScenarioTurn,
  ScenarioResult
} from '../../src/shared/quality-scenarios'
export function scenarioDigest(value: unknown): string
export function arithmeticOracle(
  source: unknown,
  name: string,
  cases: Array<[number, number]>
): Record<string, unknown>
export function assessScenarioTurn(
  turn: ScenarioTurn,
  result: ScenarioResult,
  before: Record<string, string>,
  adjudication?: unknown,
  packDigest?: string
): Record<string, unknown>
export function runScenarios(options: ScenarioOptions): Promise<{
  version: string
  rows: Array<Record<string, unknown>>
  coverage: Record<string, unknown>
  budget: Record<string, unknown>
}>
