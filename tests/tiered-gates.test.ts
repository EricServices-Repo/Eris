import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  evaluateTieredGates,
  evaluateTieredHardware,
  measureStoreStability,
  measureTieredGates,
  type TieredHardwareEvidence,
  type TieredReport
} from '../checks/tiered-gates'

const limits = JSON.parse(
  readFileSync(join(__dirname, '../checks/performance/context-budgets.json'), 'utf8')
).tiered
const live: TieredHardwareEvidence = {
  evidence: 'live-hardware',
  hostClass: 'dedicated',
  pressureSamples: 10,
  pressureAgreements: 10,
  compiledBudgetTokens: 5000,
  allocatedWindowTokens: 8192,
  actualPromptTokens: 4800,
  layersOnGpu: 33,
  totalLayers: 33,
  ramSpillBytes: 0,
  summaryCallsPerRun: 0,
  reexecutedToolsPerRun: 0,
  promptReevaluationsPerRun: 1,
  firstTokenMs: { turn1: 1000, turnN: 1100, n: 10 }
}
let shared: Promise<TieredReport> | undefined
const report = async () => structuredClone(await (shared ??= measureTieredGates()))

describe('scripted tiered gates', () => {
  it('recovers everything compaction evicts, with real compaction and journals', async () => {
    const { recoverability } = await report()
    expect(recoverability.evicted).toBeGreaterThan(100)
    expect(recoverability.recoverable).toBe(recoverability.evicted)
  })

  it('finds planted facts after 1, 3 and 10 compactions, though the prompt lost them', async () => {
    const rows = (await report()).postCompactionRecall
    expect(rows.map((row) => row.rounds)).toEqual([1, 3, 10])
    for (const row of rows) {
      expect(row.recovered).toBe(row.planted)
      expect(row.leftInPrompt).toBe(0)
    }
  })

  it('passes on the current code and labels itself scripted', async () => {
    const value = await report()
    expect(value.evidence).toBe('deterministic-scripted')
    expect(evaluateTieredGates(value, limits)).toEqual([])
  })

  it('blocks a recoverability or recall regression', async () => {
    const value = await report()
    value.recoverability.recoverable--
    value.postCompactionRecall[2]!.recovered = 0
    const failures = evaluateTieredGates(value, limits)
    expect(failures.join()).toMatch(/recoverable/)
    expect(failures.join()).toMatch(/Recall after 10 compactions/)
  })

  it('refuses a fixture that measured nothing', async () => {
    const value = await report()
    value.recoverability.evicted = 0
    expect(evaluateTieredGates(value, limits)).toEqual(['Recoverability fixture evicted nothing'])
  })

  it('refuses missing measurements or thresholds', async () => {
    expect(evaluateTieredGates(undefined, limits)).toEqual(['Missing tiered gate measurements'])
    expect(evaluateTieredGates(await report(), undefined)).toEqual([
      'Missing tiered gate thresholds'
    ])
  })
})

describe('store stability with real leases', () => {
  it('keeps the store across turns on a healthy host', async () => {
    expect(await measureStoreStability({ residentModel: true })).toEqual({ turns: 50, wipes: 0 })
  })

  it('detects the #216 regression, where a resident model is charged again', async () => {
    const regressed = await measureStoreStability({ residentModel: false })
    expect(regressed.wipes).toBeGreaterThan(0)
    const value = await report()
    const failures = evaluateTieredGates({ ...value, storeStability: regressed }, limits)
    expect(failures.join()).toMatch(/Store wiped/)
  })
})

describe('hardware evidence', () => {
  it('accepts complete live evidence within thresholds', () => {
    expect(evaluateTieredHardware(live, limits)).toEqual([])
  })

  it('never accepts scripted or missing evidence as hardware', () => {
    const scripted = { ...live, evidence: 'deterministic-scripted' } as never
    expect(evaluateTieredHardware(scripted, limits)).toEqual([
      'Release candidate lacks live hardware tiered evidence'
    ])
    expect(evaluateTieredHardware(undefined, limits)).toHaveLength(1)
  })

  it.each([
    [{ hostClass: 'unknown' as never }, /host class/],
    [{ pressureAgreements: 9 }, /disagreed with the OS/],
    [{ actualPromptTokens: 9000 }, /exceed the allocated window/],
    [{ compiledBudgetTokens: 9000 }, /exceed the allocated window/],
    [{ layersOnGpu: 20 }, /spilled to CPU/],
    [{ ramSpillBytes: 1 }, /spilled to CPU/],
    [{ summaryCallsPerRun: 99 }, /summary calls/],
    [{ reexecutedToolsPerRun: 99 }, /re-executed/],
    [{ promptReevaluationsPerRun: 99 }, /re-evaluations/],
    [{ firstTokenMs: { turn1: 1000, turnN: 9000, n: 10 } }, /latency regressed/]
  ])('fails on %j', (change, reason) => {
    expect(evaluateTieredHardware({ ...live, ...change }, limits).join()).toMatch(reason)
  })
})
