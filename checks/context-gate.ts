import {
  compileTaskContext,
  memoryForDestination
} from '../electron/main/services/agent/context-compiler'
import { createTaskContract } from '../electron/main/services/task-intake'
import type { TurnPlan } from '../src/shared/settings-schema'
import { createHash } from 'crypto'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { performanceQuantiles } from '../src/shared/performance-budget'
import { RECALL_RANKING_VERSION } from '../src/shared/recall-terms'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'
import type { ChatMessage } from '../src/shared/settings-schema'
import { LABELED } from './context-recall-labels'
import {
  evaluateTieredGates,
  evaluateTieredHardware,
  measureTieredGates,
  type TieredHardwareEvidence,
  type TieredThresholds
} from './tiered-gates'

export const CONTEXT_GATE_VERSION = 3
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
  const peakLedger = { ...store.ledger }
  let peakChargedBytes = store.ledger.ownedBytes
  const sampleLedger = () => {
    const current = store.ledger
    peakChargedBytes = Math.max(
      peakChargedBytes,
      current.ownedBytes + current.reservedBytes + current.pinnedBytes
    )
    for (const key of ['ownedBytes', 'reservedBytes', 'pinnedBytes'] as const)
      peakLedger[key] = Math.max(peakLedger[key], current[key])
  }
  const queueMs: number[] = []
  for (const query of QUERIES) {
    const samples: number[] = []
    for (let i = 0; i < SAMPLES_PER_QUERY; i++) {
      const start = performance.now()
      const pending = store.select('t', query)
      sampleLedger()
      await pending
      sampleLedger()
      samples.push(performance.now() - start)
    }
    latency[query] = performanceQuantiles(samples)
    const queued = performance.now()
    await new Promise<void>((resolve) => setImmediate(resolve))
    queueMs.push(performance.now() - queued)
    collect()
    const before = process.memoryUsage().heapUsed
    await store.select('t', query)
    heapDeltas.push(process.memoryUsage().heapUsed - before)
  }
  const appendMs: number[] = []
  for (let i = 0; i < 20; i++) {
    const at = performance.now()
    store.append(
      't',
      i + 2,
      size + i + 1,
      [{ id: `append-${i}`, role: 'user', content: 'Remember new code decision', createdAt: i }],
      size + i
    )
    appendMs.push(performance.now() - at)
    sampleLedger()
  }
  return {
    size,
    corpusHash: hash,
    denominators: { offered: size, retained, queries: QUERIES.length, samples: SAMPLES_PER_QUERY },
    measured: {
      coldInstallMs,
      latencyMs: latency,
      appendMs: performanceQuantiles(appendMs),
      eventLoopQueueMs: performanceQuantiles(queueMs),
      heapDeltaBytesMedian: performanceQuantiles(heapDeltas).p50 ?? 0,
      heapDeltaBytesMax: Math.max(0, ...heapDeltas)
    },
    estimated: {
      ledger: store.ledger,
      peakLedger,
      peakChargedBytes,
      allocationKind: 'logical owner samples; not process peak RSS'
    }
  }
}

async function measureRecall() {
  let passed = 0,
    sentPassed = 0
  const compileMs: number[] = []
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
    const selected = await store.select('t', query)
    const found = selected.inspection.facts.map((fact) => fact.sourceId)
    const task = createTaskContract({
      workspacePath: null,
      text: query,
      plan: {
        intent: 'answer',
        agentId: 'chat',
        agentName: 'Chat',
        models: { chat: 'local:qualification', tools: 'local:qualification' },
        toolPolicy: 'none'
      } as unknown as TurnPlan
    })
    const at = performance.now()
    const compiled = compileTaskContext({
      task,
      guidance: '',
      project: '',
      retrieval: '',
      maxInputTokens: 8192,
      toolsAvailable: false,
      ...memoryForDestination(selected.prompt, 'local:qualification')
    })
    compileMs.push(performance.now() - at)
    const expectedDigest = createHash('sha256').update('expected').digest('hex')
    if (
      compiled.bundle.items.some(
        (item) => item.sourceDigest === expectedDigest && item.status === 'sent'
      ) &&
      compiled.message.content.includes(expected) &&
      !compiled.message.content.includes(distractor)
    )
      sentPassed++
    if (found.includes('expected') && !found.includes('distractor')) passed++
  }
  return {
    kind: 'labeled-synthetic' as const,
    cases: LABELED.length,
    passed,
    sentCases: LABELED.length,
    sentPassed,
    compileMs: performanceQuantiles(compileMs),
    boundary: 'compiled model input; no provider inference'
  }
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
      weightsSha256?: string
      cases: number
      completed: number
      tiered?: TieredHardwareEvidence
      paired?: {
        cases: number
        baselineCorrect: number
        contextCorrect: number
        seed: string
        corpusHash: string
        baselineWeightsSha256?: string
        contextWeightsSha256?: string
        baselineBackendFingerprint?: string
        contextBackendFingerprint?: string
        sentSourceCases?: number
      }
    },
    acceptance: (input.runtime.packaged === 'true' && input.runtime.electron
      ? 'packaged-scripted'
      : 'deterministic-scripted') as 'deterministic-scripted' | 'packaged-scripted',
    notExercised: [
      'live model answers',
      ...(input.runtime.packaged === 'true' && input.runtime.electron ? [] : ['packaged runtime']),
      'hardware budget certification is evaluated separately'
    ],
    recall: await measureRecall(),
    tiered: await measureTieredGates(),
    corpora
  }
}

export type ContextBudgets = {
  version: number
  maxGrowthRatio: number
  minBaselineMs: number
  minContextAccuracy?: number
  tiered?: TieredThresholds
  profiles: Array<{
    id: string
    platform: string
    arch: string
    cpu: string
    minMemoryBytes?: number
    maxMemoryBytes?: number
    maxP95Ms: Record<string, number>
    maxAppendP95Ms?: Record<string, number>
    maxQueueP95Ms?: Record<string, number>
    maxHeapDeltaBytes?: Record<string, number>
    maxCompileP95Ms?: number
  }>
}
/** A query with no samples has no p95, which must fail rather than read as fast. */
const p95Of = (quantiles: { p95: number | null }) =>
  quantiles.p95 !== null && Number.isFinite(quantiles.p95) && quantiles.p95 >= 0
    ? quantiles.p95
    : Infinity
const worstP95 = (corpus: ContextGateReport['corpora'][number]) =>
  Math.max(...Object.values(corpus.measured.latencyMs).map(p95Of))

/** Each size and query stands alone, so one regression cannot hide in an average. */
export function evaluateContextGate(
  report: ContextGateReport,
  budgets: ContextBudgets,
  options: { releaseCandidate?: boolean } = {}
) {
  const failures: string[] = evaluateTieredGates(report.tiered, budgets.tiered)
  const notEvaluated: string[] = []
  if (
    budgets.version !== CONTEXT_GATE_VERSION ||
    !Number.isFinite(budgets.maxGrowthRatio) ||
    budgets.maxGrowthRatio <= 0 ||
    !Number.isFinite(budgets.minBaselineMs) ||
    budgets.minBaselineMs <= 0
  )
    failures.push('Invalid or incompatible context budgets')
  if (new Set(report.corpora.map((corpus) => corpus.size)).size !== report.corpora.length)
    failures.push('Duplicate corpus sizes')
  if (
    report.recall.sentCases !== report.recall.cases ||
    report.recall.sentPassed !== report.recall.cases
  )
    failures.push('Compiled-input recall denominator or quality failed')
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
    if (!Number.isSafeInteger(size) || size <= 0 || denominators.offered !== size)
      failures.push(`${size}: invalid corpus size`)
    if (
      !Number.isFinite(corpus.estimated.peakChargedBytes) ||
      corpus.estimated.peakChargedBytes > corpus.estimated.ledger.envelopeBytes
    )
      failures.push(`${size}: peak charged allocation exceeds envelope`)
    if (!/^[0-9a-f]{64}$/.test(corpusHash)) failures.push(`${size}: corpus hash missing`)
    if (!denominators.queries || !denominators.samples || !denominators.retained)
      failures.push(`${size}: empty denominator`)
    if (denominators.retained > denominators.offered)
      failures.push(`${size}: retained more than offered`)
    for (const [query, stats] of Object.entries(corpus.measured.latencyMs)) {
      if (
        !Number.isFinite(stats.p95) ||
        stats.p95 === null ||
        stats.p95 < 0 ||
        stats.samples.length !== denominators.samples ||
        stats.samples.some((n) => !Number.isFinite(n) || n < 0)
      )
        failures.push(`${size} "${query}": invalid timing samples`)
    }
    if (Object.keys(corpus.measured.latencyMs).length !== denominators.queries)
      failures.push(`${size}: query denominator mismatch`)
    const { ownedBytes, reservedBytes, pinnedBytes, envelopeBytes } = corpus.estimated.ledger
    if (
      [ownedBytes, reservedBytes, pinnedBytes, envelopeBytes].some(
        (n) => !Number.isFinite(n) || n < 0
      )
    )
      failures.push(`${size}: invalid ledger counters`)
    if (ownedBytes + reservedBytes + pinnedBytes > envelopeBytes)
      failures.push(`${size}: ledger exceeds the envelope`)
    if (reservedBytes || pinnedBytes) failures.push(`${size}: transient bytes left held`)
  }
  const ordered = [...report.corpora].sort((a, b) => a.size - b.size)
  const smallest = ordered[0]
  if (smallest)
    for (const corpus of ordered.slice(1))
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
      else if (!Number.isFinite(limit) || limit < 0)
        failures.push(`${corpus.size}: invalid hardware latency budget`)
      else if (worstP95(corpus) > limit)
        failures.push(`${corpus.size}: p95 ${worstP95(corpus).toFixed(1)} ms over ${limit} ms`)
    }
  if (smallest)
    for (const corpus of ordered.slice(1))
      for (const key of ['appendMs', 'eventLoopQueueMs'] as const) {
        if (
          p95Of(corpus.measured[key]) >
          Math.max(p95Of(smallest.measured[key]), budgets.minBaselineMs) * budgets.maxGrowthRatio
        )
          failures.push(`${corpus.size}: ${key} regressed against smallest workload`)
      }
  if (options.releaseCandidate) {
    if (profile) {
      if (
        profile.minMemoryBytes === undefined ||
        profile.maxMemoryBytes === undefined ||
        report.hardware.totalMemoryBytes < profile.minMemoryBytes ||
        report.hardware.totalMemoryBytes > profile.maxMemoryBytes
      )
        failures.push('Hardware memory is outside the qualified range')
      for (const corpus of report.corpora)
        for (const [metric, limits] of [
          ['append', profile.maxAppendP95Ms],
          ['queue', profile.maxQueueP95Ms],
          ['heap', profile.maxHeapDeltaBytes]
        ] as const) {
          const limit = limits?.[String(corpus.size)]
          const observed =
            metric === 'append'
              ? p95Of(corpus.measured.appendMs)
              : metric === 'queue'
                ? p95Of(corpus.measured.eventLoopQueueMs)
                : corpus.measured.heapDeltaBytesMax
          if (
            limit === undefined ||
            !Number.isFinite(limit) ||
            limit < 0 ||
            !Number.isFinite(observed) ||
            observed > limit
          )
            failures.push(`${corpus.size}: missing or exceeded ${metric} release budget`)
        }
      if (
        profile.maxCompileP95Ms === undefined ||
        !Number.isFinite(profile.maxCompileP95Ms) ||
        p95Of(report.recall.compileMs) > profile.maxCompileP95Ms
      )
        failures.push('Missing or exceeded compilation release budget')
    }
    if (CORPUS_SIZES.some((size) => !report.corpora.some((corpus) => corpus.size === size)))
      failures.push('Release candidate requires all 1k/10k/25k/100k workloads')
    if (
      report.acceptance !== 'packaged-scripted' ||
      !report.runtime.electron ||
      report.runtime.sourceDirty !== 'false' ||
      !/^[0-9a-f]{64}$/.test(report.runtime.lockSha256 ?? '') ||
      report.runtime.packaged !== 'true' ||
      !/^[0-9a-f]{64}$/.test(report.runtime.entrySha256 ?? '')
    )
      failures.push('Release candidate lacks packaged runtime/artifact identity')
    if (!profile || notEvaluated.length)
      failures.push('Release candidate lacks complete hardware-matched budgets')
    const paired = report.liveModel?.paired
    if (
      !report.liveModel ||
      !/^[0-9a-f]{64}$/.test(report.liveModel.weightsSha256 ?? '') ||
      !paired ||
      ![paired.cases, paired.baselineCorrect, paired.contextCorrect].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      paired.cases !== report.liveModel.cases ||
      !paired.seed ||
      !/^[0-9a-f]{64}$/.test(paired.corpusHash) ||
      paired.baselineCorrect < 0 ||
      paired.contextCorrect < paired.baselineCorrect ||
      paired.contextCorrect > paired.cases
    )
      failures.push('Release candidate lacks a complete frozen-model paired comparison')
    if (paired && report.liveModel) {
      const live = report.liveModel
      if (
        paired.baselineWeightsSha256 !== live.weightsSha256 ||
        paired.contextWeightsSha256 !== live.weightsSha256 ||
        paired.baselineBackendFingerprint !== live.backendFingerprint ||
        paired.contextBackendFingerprint !== live.backendFingerprint ||
        paired.sentSourceCases !== paired.cases
      )
        failures.push(
          'Paired comparison changed model/backend or lacks actual source-send coverage'
        )
      const accuracy = budgets.minContextAccuracy
      if (
        accuracy === undefined ||
        !Number.isFinite(accuracy) ||
        accuracy < 0 ||
        accuracy > 1 ||
        paired.contextCorrect / paired.cases < accuracy
      )
        failures.push('Paired context accuracy does not meet the release threshold')
    }
    failures.push(...evaluateTieredHardware(report.liveModel?.tiered, budgets.tiered))
    if (!/^[0-9a-f]{40}$/.test(report.gitSha))
      failures.push('Release candidate lacks a source commit identity')
    for (const corpus of report.corpora) {
      if (
        corpus.denominators.samples < SAMPLES_PER_QUERY ||
        QUERIES.some((query) => !corpus.measured.latencyMs[query])
      )
        failures.push(`${corpus.size}: incomplete release query matrix`)
    }
  }
  return {
    pass: !failures.length,
    failures,
    notEvaluated,
    profile: profile?.id ?? null,
    qualification: options.releaseCandidate ? 'release-candidate' : 'deterministic-scripted'
  }
}

/** Release certification requires independently measured packaged macOS and Windows evidence for one source. */
export function evaluateContextReleaseEvidence(
  reports: ContextGateReport[],
  budgets: ContextBudgets,
  expectedSha: string
) {
  const failures: string[] = []
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) failures.push('Invalid expected source SHA')
  for (const platform of ['darwin', 'win32']) {
    const candidates = reports.filter((report) => report.hardware.platform === platform)
    if (!candidates.length) failures.push(`Missing ${platform} packaged context evidence`)
    for (const report of candidates) {
      if (report.gitSha !== expectedSha) failures.push(`${platform}: source SHA mismatch`)
      failures.push(
        ...evaluateContextGate(report, budgets, { releaseCandidate: true }).failures.map(
          (reason) => `${platform}: ${reason}`
        )
      )
    }
  }
  if (
    reports.length !== 2 ||
    reports.some((report) => !['darwin', 'win32'].includes(report.hardware.platform))
  )
    failures.push('Expected exactly one macOS and one Windows report')
  const hostClasses = new Set(reports.map((report) => report.liveModel?.tiered?.hostClass))
  if (!hostClasses.has('unified') || !hostClasses.has('dedicated'))
    failures.push('Tiered evidence must cover one unified and one dedicated host')
  if (new Set(reports.map((report) => report.liveModel?.weightsSha256)).size > 1)
    failures.push('Platform evidence used different model weights')
  if (new Set(reports.map((report) => report.liveModel?.paired?.corpusHash)).size > 1)
    failures.push('Platform evidence used different paired corpora')
  return { pass: !failures.length, failures }
}
