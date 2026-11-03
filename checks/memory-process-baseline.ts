/**
 * RAM-CTX-056 (#228) reproduction step 1: fill the current main-process
 * ContextMemoryStore toward a 1 GiB tier and record what that costs the process that
 * also drives the UI and IPC. Measured, not estimated: V8 heap, RSS, event-loop delay
 * while selecting, and GC pauses, each beside the ledger's logical bytes. Step 2 (the
 * same workload in a dedicated memory process) belongs to the implementation.
 */
import { PerformanceObserver } from 'perf_hooks'
import { getHeapStatistics } from 'v8'
import {
  ContextMemoryStore,
  RECOVERY_RESERVATION_BYTES
} from '../electron/main/services/context-memory-store'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'
import { performanceQuantiles } from '../src/shared/performance-budget'
import { buildCorpus } from './context-gate'

const MiB = 1024 ** 2
export const BASELINE_STEPS_MIB = [128, 256, 512, 1024]
const THREAD_MIB = 128
const QUERIES = ['bookingConfirmation retry', 'src/auth/login.ts session', 'decision rounding']
const SELECTS_PER_STEP = 12
/** Rows per page, as the workspace worker hands them to hydration. */
const PAGE_ROWS = 256
/**
 * `segments` is the production hydration path (context-memory.ts): worker pages through
 * `installSegments`, which yields between bounded blocks. `sync` is the one-call
 * `install`, which production uses only for a dozen archive or pin rows. The first
 * baseline timed `sync` and reported its duration as main-thread blocking.
 */
export type BaselineInstall = 'segments' | 'sync'
/**
 * Each step fills to this share of its size. A store filled to its whole envelope has
 * no room for the ranking scratch and returns no recall (see fullTierRecall), which
 * would make every select look free.
 */
const FILL = 0.85
/** Stop before V8's own limit so the report survives to be read. */
const HEAP_HEADROOM = 0.85

const quantiles = (values: number[]) => {
  const { p50, p95 } = performanceQuantiles(values)
  return {
    p50: +(p50 ?? 0).toFixed(2),
    p95: +(p95 ?? 0).toFixed(2),
    max: +Math.max(...values).toFixed(2)
  }
}

/** Settle the heap before a sample when the runtime exposes gc (run with --expose-gc). */
const collect = () => (globalThis as { gc?: () => void }).gc?.()

/**
 * The longest stretch the event loop was blocked while `work` ran: the gap between
 * consecutive setImmediate ticks. This is what the UI and IPC would wait for.
 */
async function blocking<T>(work: () => Promise<T>): Promise<{ result: T; maxBlockMs: number }> {
  let last = performance.now()
  let max = 0
  let running = true
  const tick = () => {
    const now = performance.now()
    max = Math.max(max, now - last)
    last = now
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  const result = await work()
  running = false
  max = Math.max(max, performance.now() - last)
  return { result, maxBlockMs: max }
}

/** First row the production hydration loader would keep (context-memory.ts page loop). */
function loaderStart(records: Array<{ message: object }>, capBytes: number) {
  let bytes = 0
  for (let i = records.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(JSON.stringify(records[i]!.message)) * 4 + 512
    if (bytes >= capBytes) return i
  }
  return 0
}

type Gc = { count: number; totalMs: number; maxMs: number }

function gcObserver() {
  const gc: Gc = { count: 0, totalMs: 0, maxMs: 0 }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++
      gc.totalMs += entry.duration
      gc.maxMs = Math.max(gc.maxMs, entry.duration)
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  return {
    async take(): Promise<Gc> {
      // GC entries are delivered on a later tick; let them arrive first.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const out = { ...gc, totalMs: Math.round(gc.totalMs), maxMs: Math.round(gc.maxMs) }
      gc.count = 0
      gc.totalMs = 0
      gc.maxMs = 0
      return out
    },
    stop: () => observer.disconnect()
  }
}

export async function measureMemoryBaseline(
  options: { stepsMiB?: number[]; install?: BaselineInstall } = {}
) {
  const steps = options.stepsMiB ?? BASELINE_STEPS_MIB
  const mode: BaselineInstall = options.install ?? 'segments'
  // Threads at most as large as the smallest step, so a small run stays small.
  const threadMiB = Math.min(THREAD_MIB, ...steps)
  const limit = getHeapStatistics().heap_size_limit
  const store = new ContextMemoryStore()
  store.configure(
    ContextMemorySettingsSchema.parse({
      // Room above the fill for the ranking scratch the store reserves before a select.
      maxMemoryMiB: Math.min(
        1024,
        Math.ceil(Math.max(...steps) / FILL + RECOVERY_RESERVATION_BYTES / MiB)
      ),
      maxThreadMiB: Math.max(4, threadMiB),
      maxMessages: 100000,
      warmThreads: 16
    })
  )
  const gc = gcObserver()
  collect()
  const baseline = { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed }
  const rows: Array<Record<string, unknown>> = []
  let threads = 0
  let stopped: string | undefined
  try {
    for (const target of steps) {
      const fillStart = performance.now()
      const installMs: number[] = []
      const installBlockMs: number[] = []
      await gc.take()
      while (store.ledger.ownedBytes < target * MiB * FILL) {
        if (process.memoryUsage().heapUsed > limit * HEAP_HEADROOM) {
          stopped = `heap reached ${Math.round(HEAP_HEADROOM * 100)}% of heap_size_limit`
          break
        }
        const before = store.ledger.ownedBytes
        // One thread at about THREAD_MIB of logical bytes; ~2 KiB per corpus message.
        const key = `baseline-${threads++}`
        // Unique text per thread: identical corpora could share storage and understate cost.
        const messages = buildCorpus(Math.floor((threadMiB * MiB) / 2600)).messages.map(
          (message) => ({
            ...message,
            content: message.content.replace(/^(\S+)/, (word) => `${word} [${key}]`)
          })
        )
        let records = messages.map((message, ordinal) => ({ ordinal, message }))
        // The production loader pages newest-first and stops once its estimate reaches the
        // thread cap, so a hydrated thread never arrives larger than its cap. Mirror that;
        // otherwise the store trims half the rows after publishing and the trim is timed.
        if (mode === 'segments') records = records.slice(loaderStart(records, threadMiB * MiB))
        const input = {
          revision: 1,
          total: messages.length,
          controls: emptyMemoryControls(),
          partial: false
        }
        const installAt = performance.now()
        const { maxBlockMs } = await blocking(async () => {
          if (mode === 'sync') return store.install(key, { ...input, records }, store.token(key))
          const segments: (typeof records)[] = []
          for (let i = 0; i < records.length; i += PAGE_ROWS)
            segments.push(records.slice(i, i + PAGE_ROWS))
          return store.installSegments(key, { ...input, segments }, store.token(key))
        })
        installBlockMs.push(maxBlockMs)
        installMs.push(performance.now() - installAt)
        if (store.ledger.ownedBytes <= before) {
          stopped = 'the store admitted no more threads at this budget'
          break
        }
      }
      const fillGc = await gc.take()
      const fillMs = performance.now() - fillStart
      const selectMs: number[] = []
      const blockMs: number[] = []
      const selected = { facts: 0, retained: 0, empty: 0 }
      for (let i = 0; i < SELECTS_PER_STEP; i++) {
        const at = performance.now()
        const {
          result: { inspection },
          maxBlockMs
        } = await blocking(() =>
          store.select(`baseline-${i % threads}`, QUERIES[i % QUERIES.length]!)
        )
        selectMs.push(performance.now() - at)
        blockMs.push(maxBlockMs)
        selected.facts += inspection.facts.length
        selected.retained += inspection.manifest.retainedMessages
        if (!inspection.facts.length) selected.empty++
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const selectGc = await gc.take()
      collect()
      const memory = process.memoryUsage()
      const ledger = store.ledger
      rows.push({
        targetMiB: target,
        threads,
        ledgerOwnedMiB: Math.round(ledger.ownedBytes / MiB),
        heapUsedMiB: Math.round(memory.heapUsed / MiB),
        heapGrowthMiB: Math.round((memory.heapUsed - baseline.heap) / MiB),
        rssMiB: Math.round(memory.rss / MiB),
        rssGrowthMiB: Math.round((memory.rss - baseline.rss) / MiB),
        heapPerLedgerByte: +((memory.heapUsed - baseline.heap) / ledger.ownedBytes).toFixed(2),
        rssPerLedgerByte: +((memory.rss - baseline.rss) / ledger.ownedBytes).toFixed(2),
        heapLimitShare: +(memory.heapUsed / limit).toFixed(2),
        fillMs: Math.round(fillMs),
        fillGc,
        selectMs: quantiles(selectMs),
        selectsWithNoFacts: selected.empty,
        meanRetainedRowsPerSelect: Math.round(selected.retained / SELECTS_PER_STEP),
        selectGc,
        selectMaxBlockMs: quantiles(blockMs),
        installMs: quantiles(installMs),
        installMaxBlockMs: quantiles(installBlockMs)
      })
      if (stopped) break
    }
  } finally {
    gc.stop()
  }
  return {
    version: 2 as const,
    install: mode,
    fullTierRecall: await fullTierRecall(Math.max(16, threadMiB)),
    evidence: 'measured-process' as const,
    boundary: 'ContextMemoryStore in the measuring process; synthetic corpus; no UI or IPC load',
    heapSizeLimitMiB: Math.round(limit / MiB),
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
    processType: (process as { type?: string }).type ?? 'node',
    gcForcedBeforeSample: typeof (globalThis as { gc?: unknown }).gc === 'function',
    stopped: stopped ?? null,
    steps: rows
  }
}

/**
 * One full thread in an envelope of the same size, then in one with room for the
 * ranking scratch (twice RECOVERY_RESERVATION_BYTES larger): does a
 * select still return facts once the tier is full?
 */
async function fullTierRecall(sizeMiB: number) {
  const { messages } = buildCorpus(Math.floor((sizeMiB * MiB) / 2600))
  const out: Array<{
    envelopeMiB: number
    ownedMiB: number
    facts: number
    reason: string | null
  }> = []
  for (const envelope of [sizeMiB, sizeMiB + Math.ceil((2 * RECOVERY_RESERVATION_BYTES) / MiB)]) {
    const store = new ContextMemoryStore()
    store.configure(
      ContextMemorySettingsSchema.parse({
        maxMemoryMiB: envelope,
        maxThreadMiB: sizeMiB,
        maxMessages: 100000
      })
    )
    store.install(
      'full',
      {
        revision: 1,
        total: messages.length,
        records: messages.map((message, ordinal) => ({ ordinal, message })),
        controls: emptyMemoryControls(),
        partial: false
      },
      store.token('full')
    )
    const { inspection } = await store.select('full', QUERIES[0]!)
    out.push({
      envelopeMiB: envelope,
      ownedMiB: Math.round(store.ledger.ownedBytes / MiB),
      facts: inspection.facts.length,
      reason: inspection.manifest.reason ?? null
    })
    store.clear()
  }
  return out
}
