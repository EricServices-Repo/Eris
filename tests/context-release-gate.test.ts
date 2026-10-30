import { describe, expect, it } from 'vitest'
import {
  buildCorpus,
  evaluateContextGate,
  runContextGate,
  type ContextBudgets,
  type ContextGateReport
} from '../checks/context-gate'

const budgets: ContextBudgets = { version: 1, maxGrowthRatio: 12, profiles: [] }
const hardware = { platform: 'test', arch: 'x', cpu: 'cpu', totalMemoryBytes: 1 }
const measured = () =>
  runContextGate({ sizes: [200, 400], gitSha: 'abc', hardware, runtime: { node: '1' } })
let shared: Promise<ContextGateReport> | undefined
const report = async () => structuredClone(await (shared ??= measured()))
const failures = (value: ContextGateReport, limits = budgets) =>
  evaluateContextGate(value, limits).failures

describe('corpus identity', () => {
  it('hashes the same corpus the same way', () => {
    expect(buildCorpus(100).hash).toBe(buildCorpus(100).hash)
    expect(buildCorpus(100).hash).not.toBe(buildCorpus(101).hash)
  })
  it('includes code, metadata, Unicode and decisions', () => {
    const text = buildCorpus(40).messages.map((message) => message.content)
    expect(text.some((content) => content.includes('export function'))).toBe(true)
    expect(text.some((content) => content.includes('Tool result'))).toBe(true)
    expect(text.some((content) => content.includes('決済'))).toBe(true)
    expect(text.some((content) => content.startsWith('Decision'))).toBe(true)
  })
})

describe('report contents', () => {
  it('records hashes, denominators and scripted acceptance', async () => {
    const value = await report()
    expect(value.liveModel).toBeNull()
    expect(value.acceptance).toBe('deterministic-scripted')
    expect(value.notExercised).toContain('live model answers')
    for (const corpus of value.corpora) {
      expect(corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/)
      expect(corpus.denominators.retained).toBeGreaterThan(0)
      expect(corpus.measured.latencyMs).toBeDefined()
      expect(corpus.estimated.ledger.envelopeBytes).toBeGreaterThan(0)
    }
  })
  it('passes a real run and reports unmeasured budgets as not evaluated', async () => {
    const result = evaluateContextGate(await report(), { ...budgets, maxGrowthRatio: 1000 })
    expect(result.failures).toEqual([])
    expect(result.pass).toBe(true)
    expect(result.notEvaluated[0]).toMatch(/no budget profile/)
    expect(result.profile).toBeNull()
  })
})

describe('regressions cannot hide', () => {
  const quiet = { ...budgets, maxGrowthRatio: 1000 }
  it('fails one slow query despite fast neighbours', async () => {
    const value = await report()
    const [query] = Object.keys(value.corpora[1]!.measured.latencyMs)
    value.corpora[1]!.measured.latencyMs[query!]!.p95 = 1e7
    expect(failures(value, quiet).join()).toMatch(/grew past/)
  })
  it('applies a matching hardware budget per size', async () => {
    const value = await report()
    const limits = {
      ...quiet,
      profiles: [{ id: 'p', platform: 'test', arch: 'x', cpu: 'cpu', maxP95Ms: { '400': 0 } }]
    }
    const result = evaluateContextGate(value, limits)
    expect(result.failures.join()).toMatch(/^400: p95/)
    expect(result.notEvaluated).toContain('Absolute latency: no 200 budget')
  })
  it('fails missing recall cases or a recall drop', async () => {
    const value = await report()
    value.recall.passed--
    expect(failures(value, quiet).join()).toMatch(/Recall passed/)
    value.recall.cases = 0
    expect(failures(value, quiet).join()).toMatch(/no cases/)
  })
  it('fails empty denominators and missing hashes', async () => {
    const value = await report()
    value.corpora[0]!.denominators.samples = 0
    value.corpora[0]!.corpusHash = ''
    const text = failures(value, quiet).join()
    expect(text).toMatch(/empty denominator/)
    expect(text).toMatch(/corpus hash missing/)
  })
  it('fails a ledger over its envelope or holding transient bytes', async () => {
    const value = await report()
    const { ledger } = value.corpora[0]!.estimated
    ledger.ownedBytes = ledger.envelopeBytes + 1
    ledger.reservedBytes = 1
    const text = failures(value, quiet).join()
    expect(text).toMatch(/exceeds the envelope/)
    expect(text).toMatch(/transient bytes/)
  })
})

describe('live claims', () => {
  const quiet = { ...budgets, maxGrowthRatio: 1000 }
  const live = { model: 'm', backendFingerprint: 'f', cases: 10000, completed: 10000 }
  it('rejects a partial run claimed as complete', async () => {
    const value = await report()
    value.liveModel = { ...live, completed: 120 }
    expect(failures(value, quiet).join()).toMatch(/120\/10000/)
  })
  it('rejects a run with no model or backend fingerprint', async () => {
    const value = await report()
    value.liveModel = { ...live, backendFingerprint: '' }
    expect(failures(value, quiet).join()).toMatch(/fingerprint/)
  })
  it('accepts a completed fingerprinted run', async () => {
    const value = await report()
    value.liveModel = live
    expect(failures(value, quiet)).toEqual([])
  })
})
