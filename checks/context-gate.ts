import { createHash } from 'crypto'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { performanceQuantiles } from '../src/shared/performance-budget'
import { RECALL_RANKING_VERSION } from '../src/shared/recall-terms'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
import { LABELED } from './context-recall-labels'

export const CONTEXT_GATE_VERSION = 1
export const CORPUS_VERSION = 'eris-context-corpus-1'
export const CORPUS_SIZES = [1000, 10000, 25000, 100000]
const QUERIES = [
  'bookingConfirmation retry',
  'src/auth/login.ts session',
  '決済 通貨',
  'decision rounding',
  'Go runtime',
  'unrelatedterm'
]
const SAMPLES_PER_QUERY = 40

const code = (i: number) =>
  `Edited src/module-${i % 400}/service-${i}.ts\n` +
  `export function handleRequest${i}(input: Input) {\n  return retry(input, ${i})\n}\n`.repeat(24)
const metadata = (i: number) =>
  `Tool result ${i}: ` + `/workspace/packages/app-${i % 40}/src/feature/index.ts `.repeat(30)
const unicode = (i: number) =>
  `決済通貨はカナダドルです ${i}。 Café résumé naïve München ${i}. `.repeat(12)
const decision = (i: number) => `Decision ${i}: keep rounding in the ledger for bookingConfirmation`

/** Deterministic mix of the workloads the issue names, so a hash identifies a corpus. */
export function buildCorpus(size: number) {
  const hash = createHash('sha256').update(CORPUS_VERSION)
  const messages: ChatMessage[] = []
  for (let i = 0; i < size; i++) {
    const kind = i % 20
    const content =
      kind < 12 ? code(i) : kind < 16 ? metadata(i) : kind < 19 ? unicode(i) : decision(i)
    hash.update(content)
    messages.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content, createdAt: i })
  }
  return { messages, hash: hash.digest('hex') }
}

function install(store: ContextMemoryStore, key: string, messages: ChatMessage[]) {
  return store.install(
    key,
    {
      revision: 1,
      total: messages.length,
      records: messages.map((message, ordinal) => ({ ordinal, message })),
      controls: emptyMemoryControls(),
      partial: false
    },
    store.token(key)
  )
}
const collect = () => (globalThis as { gc?: () => void }).gc?.()

async function measureCorpus(size: number) {
  const { messages, hash } = buildCorpus(size)
  const store = new ContextMemoryStore()
  store.configure(
    ContextMemorySettingsSchema.parse({
      maxMemoryMiB: 512,
      maxThreadMiB: 128,
      maxMessages: 100000,
      warmThreads: 16
    })
  )
  const coldStart = performance.now()
  install(store, 't', messages)
  const coldInstallMs = performance.now() - coldStart
  const retained = (await store.select('t', 'x')).inspection.manifest.retainedMessages
  const latency: Record<string, ReturnType<typeof performanceQuantiles>> = {}
  const heapDeltas: number[] = []
  for (const query of QUERIES) {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES_PER_QUERY; i++) {
      const start = performance.now()
      await store.select('t', query)
      samples.push(performance.now() - start)
    }
    latency[query] = performanceQuantiles(samples)
    collect()
    const before = process.memoryUsage().heapUsed
    await store.select('t', query)
    heapDeltas.push(process.memoryUsage().heapUsed - before)
  }
  return {
    size,
    corpusHash: hash,
    denominators: { offered: size, retained, queries: QUERIES.length, samples: SAMPLES_PER_QUERY },
    measured: {
      coldInstallMs,
      latencyMs: latency,
      heapDeltaBytesMedian: performanceQuantiles(heapDeltas).p50 ?? 0
    },
    estimated: { ledger: store.ledger }
  }
}

async function measureRecall() {
  let passed = 0
  for (const { query, expected, distractor } of LABELED) {
    const store = new ContextMemoryStore()
    const noise = Array.from({ length: 40 }, (_, i) => ({
      id: `noise-${i}`,
      role: 'user' as const,
      content: `Routine status update ${i}`,
      createdAt: 1
    }))
    install(store, 't', [
      { id: 'expected', role: 'user', content: expected, createdAt: 1 },
      { id: 'distractor', role: 'user', content: distractor, createdAt: 1 },
      ...noise
    ])
    const found = (await store.select('t', query)).inspection.facts.map((fact) => fact.sourceId)
    if (found.includes('expected') && !found.includes('distractor')) passed++
  }
  return { kind: 'labeled-synthetic' as const, cases: LABELED.length, passed }
}

export type ContextGateReport = Awaited<ReturnType<typeof runContextGate>>
export async function runContextGate(input: {
  sizes?: number[]
  gitSha: string
  hardware: { platform: string; arch: string; cpu?: string; totalMemoryBytes: number }
  runtime: Record<string, string | undefined>
}) {
  const corpora = []
  for (const size of input.sizes ?? CORPUS_SIZES) corpora.push(await measureCorpus(size))
  return {
    version: CONTEXT_GATE_VERSION,
    corpusVersion: CORPUS_VERSION,
    rankingVersion: RECALL_RANKING_VERSION,
    gitSha: input.gitSha,
    hardware: input.hardware,
    runtime: input.runtime,
    /** Scripted by default. A live claim must name its model and complete every case. */
    liveModel: null as null | {
      model: string
      backendFingerprint: string
      cases: number
      completed: number
    },
    acceptance: 'deterministic-scripted' as const,
    notExercised: ['live model answers', 'packaged runtime', 'Windows hardware budgets'],
    recall: await measureRecall(),
    corpora
  }
}

export type ContextBudgets = {
  version: number
  maxGrowthRatio: number
  minBaselineMs: number
  profiles: Array<{
    id: string
    platform: string
    arch: string
    cpu: string
    maxP95Ms: Record<string, number>
  }>
}
/** A query with no samples has no p95, which must fail rather than read as fast. */
const p95Of = (quantiles: { p95: number | null }) => quantiles.p95 ?? Infinity
const worstP95 = (corpus: ContextGateReport['corpora'][number]) =>
  Math.max(...Object.values(corpus.measured.latencyMs).map(p95Of))

/** Each size and query stands alone, so one regression cannot hide in an average. */
export function evaluateContextGate(report: ContextGateReport, budgets: ContextBudgets) {
  const failures: string[] = []
  const notEvaluated: string[] = []
  if (report.version !== CONTEXT_GATE_VERSION) failures.push('Report version mismatch')
  if (!report.corpora.length) failures.push('No corpus was measured')
  if (!report.recall.cases) failures.push('Recall has no cases')
  else if (report.recall.passed !== report.recall.cases)
    failures.push(`Recall passed ${report.recall.passed}/${report.recall.cases} labeled cases`)
  const { liveModel } = report
  if (liveModel) {
    if (!liveModel.model || !liveModel.backendFingerprint)
      failures.push('Live run has no model or backend fingerprint')
    if (!liveModel.cases || liveModel.completed !== liveModel.cases)
      failures.push(`Live run completed ${liveModel.completed}/${liveModel.cases} cases`)
  }
  for (const corpus of report.corpora) {
    const { denominators, corpusHash, size } = corpus
    if (!/^[0-9a-f]{64}$/.test(corpusHash)) failures.push(`${size}: corpus hash missing`)
    if (!denominators.queries || !denominators.samples || !denominators.retained)
      failures.push(`${size}: empty denominator`)
    if (denominators.retained > denominators.offered)
      failures.push(`${size}: retained more than offered`)
    const { ownedBytes, reservedBytes, pinnedBytes, envelopeBytes } = corpus.estimated.ledger
    if (ownedBytes + reservedBytes + pinnedBytes > envelopeBytes)
      failures.push(`${size}: ledger exceeds the envelope`)
    if (reservedBytes || pinnedBytes) failures.push(`${size}: transient bytes left held`)
  }
  const smallest = report.corpora[0]
  if (smallest)
    for (const corpus of report.corpora.slice(1))
      for (const [query, quantiles] of Object.entries(corpus.measured.latencyMs)) {
        const base = smallest.measured.latencyMs[query]
        const p95 = p95Of(quantiles)
        // A floor keeps small-baseline timer noise from reading as growth.
        if (base && p95 > Math.max(p95Of(base), budgets.minBaselineMs) * budgets.maxGrowthRatio)
          failures.push(
            `${corpus.size} "${query}": p95 ${p95.toFixed(1)} ms grew past ` +
              `${budgets.maxGrowthRatio}x the ${smallest.size} baseline`
          )
      }
  const profile = budgets.profiles.find(
    ({ platform, arch, cpu }) =>
      platform === report.hardware.platform &&
      arch === report.hardware.arch &&
      cpu === report.hardware.cpu
  )
  if (!profile) notEvaluated.push('Absolute latency: no budget profile for this hardware')
  else
    for (const corpus of report.corpora) {
      const limit = profile.maxP95Ms[String(corpus.size)]
      if (limit === undefined) notEvaluated.push(`Absolute latency: no ${corpus.size} budget`)
      else if (worstP95(corpus) > limit)
        failures.push(`${corpus.size}: p95 ${worstP95(corpus).toFixed(1)} ms over ${limit} ms`)
    }
  return { pass: !failures.length, failures, notEvaluated, profile: profile?.id ?? null }
}
