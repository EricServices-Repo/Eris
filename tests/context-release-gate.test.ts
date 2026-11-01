import { createRequire } from 'module'
const { contextReleasePolicy } = createRequire(import.meta.url)(
  '../scripts/context-release-policy.cjs'
)
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildCorpus,
  evaluateContextGate,
  evaluateContextReleaseEvidence,
  runContextGate,
  type ContextBudgets,
  type ContextGateReport
} from '../checks/context-gate'

const tieredLimits = JSON.parse(
  readFileSync(join(__dirname, '../checks/performance/context-budgets.json'), 'utf8')
).tiered
const budgets: ContextBudgets = {
  version: 3,
  maxGrowthRatio: 12,
  minBaselineMs: 5,
  tiered: tieredLimits,
  profiles: []
}
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
  it('ignores timer noise on a small baseline but not a real slowdown', async () => {
    const value = await report()
    const [query] = Object.keys(value.corpora[1]!.measured.latencyMs)
    value.corpora[0]!.measured.latencyMs[query!]!.p95 = 2.4
    value.corpora[1]!.measured.latencyMs[query!]!.p95 = 29.3
    expect(failures(value, budgets).join()).not.toMatch(/grew past/)
    value.corpora[1]!.measured.latencyMs[query!]!.p95 = 61
    expect(failures(value, budgets).join()).toMatch(/grew past/)
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

describe('strict release qualification', () => {
  it('does not certify scripted CI or an unknown hardware profile as a release', async () => {
    const result = evaluateContextGate(await report(), budgets, { releaseCandidate: true })
    expect(result.pass).toBe(false)
    expect(result.failures.join()).toMatch(/packaged runtime/)
    expect(result.failures.join()).toMatch(/hardware-matched/)
    expect(result.failures.join()).toMatch(/frozen-model/)
    expect(result.failures.join()).toMatch(/all 1k/)
  })
  it('rejects invalid numeric samples and duplicate corpus denominators', async () => {
    const value = await report()
    const stats = Object.values(value.corpora[0].measured.latencyMs)[0]!
    stats.p95 = NaN
    stats.samples[0] = Infinity
    value.corpora.push(structuredClone(value.corpora[0]))
    const result = evaluateContextGate(value, budgets)
    expect(result.pass).toBe(false)
    expect(result.failures.join()).toMatch(/invalid timing/)
    expect(result.failures.join()).toMatch(/Duplicate/)
  })
  it('gates actually compiled input, not only the selector result', async () => {
    const value = await report()
    expect(value.recall.sentCases).toBe(value.recall.cases)
    expect(value.recall.sentPassed).toBe(value.recall.cases)
    value.recall.sentPassed--
    expect(evaluateContextGate(value, budgets).failures.join()).toMatch(/Compiled-input/)
  })
  it('records transient reservation peaks and independent append/queue metrics', async () => {
    const value = await report()
    for (const corpus of value.corpora) {
      expect(corpus.estimated.peakLedger.reservedBytes).toBeGreaterThan(0)
      expect(corpus.estimated.ledger.reservedBytes).toBe(0)
      expect(corpus.measured.appendMs.samples).toHaveLength(20)
      expect(corpus.measured.eventLoopQueueMs.samples).toHaveLength(corpus.denominators.queries)
    }
  })
})

it('requires both packaged platforms for the exact release source', async () => {
  const value = await report()
  value.hardware.platform = 'darwin'
  const checked = evaluateContextReleaseEvidence([value], budgets, 'a'.repeat(40))
  expect(checked.pass).toBe(false)
  expect(checked.failures.join()).toMatch(/Missing win32/)
  expect(checked.failures.join()).toMatch(/source SHA mismatch/)
})

it('accepts complete validator fixtures and rejects model substitution in paired evidence', async () => {
  // Validator-only fixtures: copied timings are not measured packaged/hardware acceptance.
  const base = await report()
  const sha = 'a'.repeat(40),
    weights = 'b'.repeat(64),
    corpus = 'c'.repeat(64)
  const platforms = ['darwin', 'win32']
  const reports = platforms.map((platform) => {
    const value = structuredClone(base)
    value.gitSha = sha
    value.hardware.platform = platform
    value.acceptance = 'packaged-scripted'
    value.runtime = {
      electron: 'fixture',
      node: 'fixture',
      packaged: 'true',
      sourceDirty: 'false',
      lockSha256: 'd'.repeat(64),
      entrySha256: 'e'.repeat(64)
    }
    value.corpora = [1000, 10000, 25000, 100000].map((size) => ({
      ...structuredClone(base.corpora[0]),
      size,
      denominators: { ...base.corpora[0].denominators, offered: size }
    }))
    value.liveModel = {
      model: 'frozen',
      backendFingerprint: `backend-${platform}`,
      weightsSha256: weights,
      cases: 20,
      completed: 20,
      tiered: {
        evidence: 'live-hardware',
        hostClass: platform === 'darwin' ? 'unified' : 'dedicated',
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
      },
      paired: {
        cases: 20,
        baselineCorrect: 12,
        contextCorrect: 20,
        seed: 'fixed',
        corpusHash: corpus,
        baselineWeightsSha256: weights,
        contextWeightsSha256: weights,
        baselineBackendFingerprint: `backend-${platform}`,
        contextBackendFingerprint: `backend-${platform}`,
        sentSourceCases: 20
      }
    }
    return value
  })
  const sameClass = structuredClone(reports)
  sameClass[1]!.liveModel!.tiered!.hostClass = 'unified'
  expect(evaluateContextReleaseEvidence(sameClass, budgets, sha).failures).toContain(
    'Tiered evidence must cover one unified and one dedicated host'
  )
  const limits: ContextBudgets = {
    ...budgets,
    minContextAccuracy: 0.95,
    profiles: platforms.map((platform) => ({
      id: platform,
      platform,
      arch: 'x',
      cpu: 'cpu',
      minMemoryBytes: 1,
      maxMemoryBytes: 1,
      maxP95Ms: Object.fromEntries([1000, 10000, 25000, 100000].map((size) => [size, 1e7])),
      maxAppendP95Ms: Object.fromEntries([1000, 10000, 25000, 100000].map((size) => [size, 1e7])),
      maxQueueP95Ms: Object.fromEntries([1000, 10000, 25000, 100000].map((size) => [size, 1e7])),
      maxHeapDeltaBytes: Object.fromEntries(
        [1000, 10000, 25000, 100000].map((size) => [size, 1e12])
      ),
      maxCompileP95Ms: 1e7
    }))
  }
  expect(evaluateContextReleaseEvidence(reports, limits, sha)).toMatchObject({ pass: true })
  reports[1].liveModel!.paired!.contextWeightsSha256 = 'f'.repeat(64)
  expect(evaluateContextReleaseEvidence(reports, limits, sha).failures.join()).toMatch(
    /changed model/
  )
})

it('requires real certification for 1.x, explicitly certified runs and any supplied evidence', () => {
  expect(contextReleasePolicy({ version: '0.6.7' })).toMatchObject({
    strict: false,
    qualification: 'development-scripted-only'
  })
  expect(contextReleasePolicy({ version: '1.0.1' }).strict).toBe(true)
  expect(contextReleasePolicy({ version: '0.6.7', requireCertification: true }).strict).toBe(true)
  expect(contextReleasePolicy({ version: '0.6.7', evidenceRunId: '123' }).strict).toBe(true)
  expect(() => contextReleasePolicy({ version: 'bad' })).toThrow()
  expect(() => contextReleasePolicy({ version: '0.6.7', evidenceRunId: 'untrusted' })).toThrow()
})

it('keeps real legacy glob and asar callers compatible with the patched matching engine', async () => {
  const require = createRequire(import.meta.url)
  const mm = require('minimatch')
  expect(require('minimatch/package.json').version).toBe('11.0.1')
  expect(mm('src/app.ts', '**/*.ts')).toBe(true)
  expect(mm.minimatch('src/app.ts', '**/*.ts')).toBe(true)
  expect(new mm.Minimatch('**/*.node').match('native/addon.node')).toBe(true)
  expect(mm.defaults({ dot: true })('.hidden/file', '**/*')).toBe(true)
  expect(require('glob').sync('src/shared/*.ts').length).toBeGreaterThan(10)
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eris-patched-asar-'))
  try {
    const source = path.join(dir, 'source')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'app.js'), 'module.exports = 1')
    fs.writeFileSync(path.join(source, 'addon.node'), 'fixture')
    const archive = path.join(dir, 'app.asar'),
      asar = require('@electron/asar')
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' })
    expect(asar.extractFile(archive, 'app.js').toString()).toBe('module.exports = 1')
    expect(fs.existsSync(`${archive}.unpacked/addon.node`)).toBe(true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
