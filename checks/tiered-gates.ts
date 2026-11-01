import { microCompactAgentMessages } from '../electron/main/services/agent/compaction'
import { RunJournal } from '../electron/main/services/agent/run-journal'
import type { AgentChatMessage } from '../electron/main/services/agent/types'
import { ContextMemoryStore } from '../electron/main/services/context-memory-store'
import { InferenceGovernor } from '../electron/main/services/inference-governor'
import { ContextMemorySettingsSchema, emptyMemoryControls } from '../src/shared/context-memory'

const G = 1024 ** 3
const RECOVERABILITY_RESULTS = 200
const COMPACTION_BUDGET_TOKENS = 2_000
const COMPACTION_ROUNDS = [1, 3, 10]
const FACTS_PER_RUN = 3
const STABILITY_TURNS = 50

export type TieredThresholds = {
  /** Share of evicted content recoverable by ref. */
  minRecoverableShare: number
  /** Share of planted facts found after each compaction round. */
  minPostCompactionRecall: number
  maxStoreWipesPerTurn: number
  maxSummaryCallsPerRun: number
  maxReexecutedToolsPerRun: number
  maxPromptReevaluationsPerRun: number
  /** Turn N first-token time as a multiple of turn 1. */
  maxTurnNLatencyRatio: number
}

/** Measured on real hardware with a real model. Never filled from a scripted run. */
export type TieredHardwareEvidence = {
  evidence: 'live-hardware'
  hostClass: 'unified' | 'dedicated'
  pressureSamples: number
  pressureAgreements: number
  compiledBudgetTokens: number
  allocatedWindowTokens: number
  actualPromptTokens: number
  layersOnGpu: number
  totalLayers: number
  ramSpillBytes: number
  summaryCallsPerRun: number
  reexecutedToolsPerRun: number
  promptReevaluationsPerRun: number
  firstTokenMs: { turn1: number; turnN: number; n: number }
}

const body = (index: number, planted = '') =>
  `result ${index} head\n${'filler line\n'.repeat(600)}${planted}${'filler line\n'.repeat(600)}result ${index} tail`

function toolMessage(id: string, content: string): AgentChatMessage {
  return { role: 'tool', tool_call_id: id, content } as AgentChatMessage
}

/** Its own store: the shared one follows this machine's pressure, which is not under test. */
function newJournal(runId: string) {
  const store = new ContextMemoryStore()
  store.configure(ContextMemorySettingsSchema.parse({}))
  return new RunJournal({ runId, taskId: runId, memoryKey: `gate:${runId}` }, store)
}

async function recorded(journal: RunJournal, id: string, content: string) {
  await journal.append({ toolName: 'run', toolCallId: id, args: {}, content })
  return toolMessage(id, content)
}

/** Every result whose prompt text compaction changed must come back byte-identically. */
async function measureRecoverability() {
  const journal = newJournal('gate-recoverable')
  try {
    const originals = new Map<string, string>()
    const messages: AgentChatMessage[] = [{ role: 'system', content: 'system' }]
    for (let index = 0; index < RECOVERABILITY_RESULTS; index++) {
      const id = `recover-${index}`
      originals.set(id, body(index))
      messages.push(await recorded(journal, id, body(index)))
    }
    const compacted = microCompactAgentMessages(
      messages,
      COMPACTION_BUDGET_TOKENS,
      journal
    ).messages
    let evicted = 0
    let recoverable = 0
    for (const message of compacted) {
      const id = (message as { tool_call_id?: string }).tool_call_id
      if (!id || message.content === originals.get(id)) continue
      evicted++
      // The ref a model would use: the one printed in the prompt, not a side lookup.
      const ref = message.content.match(/^\[ref:([0-9a-f]+) /)?.[1] ?? ''
      const read = await journal.read(ref)
      if (read.status === 'found' && read.content === originals.get(id)) recoverable++
    }
    return { results: RECOVERABILITY_RESULTS, evicted, recoverable }
  } finally {
    journal.close()
  }
}

/** Facts sit mid-output, where compaction removes them from the prompt. */
async function measureRecallAfter(rounds: number) {
  const journal = newJournal(`gate-recall-${rounds}`)
  try {
    const facts = Array.from({ length: FACTS_PER_RUN }, (_, index) => `PLANTED-FACT-${index}\n`)
    let messages: AgentChatMessage[] = [{ role: 'system', content: 'system' }]
    for (const [index, fact] of facts.entries())
      messages.push(await recorded(journal, `fact-${index}`, body(index, fact)))
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < 20; index++)
        messages.push(await recorded(journal, `r${round}-${index}`, body(index)))
      messages = microCompactAgentMessages(messages, COMPACTION_BUDGET_TOKENS, journal).messages
    }
    const prompt = messages.map((message) => message.content).join('\n')
    const texts = await Promise.all(journal.list().map((entry) => journal.read(entry.ref)))
    const recovered = facts.filter((fact) =>
      texts.some((read) => read.status === 'found' && read.content.includes(fact))
    )
    return {
      rounds,
      planted: facts.length,
      recovered: recovered.length,
      leftInPrompt: facts.filter((fact) => prompt.includes(fact)).length
    }
  } finally {
    journal.close()
  }
}

/** Real leases against a real store on a healthy host, as a chat session makes them. */
export async function measureStoreStability(options: { residentModel: boolean }) {
  const modelBytes = 8 * G
  const governor = new InferenceGovernor(() => ({ total: 16 * G, free: 6 * G, reserve: 2 * G }))
  const store = new ContextMemoryStore()
  store.configure(ContextMemorySettingsSchema.parse({}))
  governor.registerOptionalMemory({
    ledger: () => store.ledger,
    limit: (bytes) => void store.setPressureLimit(bytes)
  })
  const key = 'gate:stability'
  const install = () =>
    store.install(
      key,
      {
        revision: 1,
        sourceEpoch: 'gate',
        total: 20,
        records: Array.from({ length: 20 }, (_, ordinal) => ({
          ordinal,
          message: { id: `m${ordinal}`, role: 'user' as const, content: 'remember', createdAt: 1 }
        })),
        controls: emptyMemoryControls(),
        partial: false
      },
      store.token(key)
    )
  install()
  let wipes = 0
  for (let turn = 0; turn < STABILITY_TURNS; turn++) {
    const lease = await governor.acquire({
      workload: 'text',
      requestedBytes: modelBytes,
      ...(options.residentModel ? { residentBytes: modelBytes } : {}),
      gpu: false
    })
    if (!store.has(key)) {
      wipes++
      install()
    }
    lease.release()
  }
  store.clear()
  return { turns: STABILITY_TURNS, wipes }
}

export async function measureTieredGates() {
  return {
    /** Scripted by construction. Hardware evidence lives on `liveModel.tiered`. */
    evidence: 'deterministic-scripted' as const,
    recoverability: await measureRecoverability(),
    postCompactionRecall: await Promise.all(COMPACTION_ROUNDS.map(measureRecallAfter)),
    storeStability: await measureStoreStability({ residentModel: true })
  }
}

export type TieredReport = Awaited<ReturnType<typeof measureTieredGates>>

/** Runs on every context gate, so a regression here blocks CI and release builds. */
export function evaluateTieredGates(tiered: TieredReport | undefined, limits?: TieredThresholds) {
  if (!limits) return ['Missing tiered gate thresholds']
  if (!tiered) return ['Missing tiered gate measurements']
  const failures: string[] = []
  const { recoverability, postCompactionRecall, storeStability } = tiered
  if (!recoverability.evicted) failures.push('Recoverability fixture evicted nothing')
  else if (recoverability.recoverable / recoverability.evicted < limits.minRecoverableShare)
    failures.push(
      `Only ${recoverability.recoverable}/${recoverability.evicted} evicted results are recoverable`
    )
  for (const row of postCompactionRecall) {
    if (row.leftInPrompt) failures.push(`${row.rounds} compactions left a planted fact in prompt`)
    if (row.recovered / row.planted < limits.minPostCompactionRecall)
      failures.push(`Recall after ${row.rounds} compactions: ${row.recovered}/${row.planted}`)
  }
  if (storeStability.wipes / storeStability.turns > limits.maxStoreWipesPerTurn)
    failures.push(`Store wiped on ${storeStability.wipes}/${storeStability.turns} healthy turns`)
  return failures
}

const positive = (value: unknown) => typeof value === 'number' && value > 0

/** Release-only: a live, hardware-labelled measurement of what scripted runs cannot see. */
export function evaluateTieredHardware(
  evidence: TieredHardwareEvidence | undefined,
  limits?: TieredThresholds
) {
  if (!limits) return ['Missing tiered gate thresholds']
  if (evidence?.evidence !== 'live-hardware')
    return ['Release candidate lacks live hardware tiered evidence']
  const failures: string[] = []
  const check = (ok: boolean, message: string) => void (ok || failures.push(message))
  check(
    evidence.hostClass === 'unified' || evidence.hostClass === 'dedicated',
    'Tiered evidence does not record its host class'
  )
  check(
    positive(evidence.pressureSamples) && evidence.pressureAgreements === evidence.pressureSamples,
    'Pressure state disagreed with the OS'
  )
  check(
    positive(evidence.allocatedWindowTokens) &&
      evidence.compiledBudgetTokens <= evidence.allocatedWindowTokens &&
      evidence.actualPromptTokens <= evidence.allocatedWindowTokens,
    'Budget or actual tokens exceed the allocated window'
  )
  check(
    positive(evidence.totalLayers) &&
      evidence.layersOnGpu === evidence.totalLayers &&
      evidence.ramSpillBytes === 0,
    'Model layers spilled to CPU'
  )
  check(evidence.summaryCallsPerRun <= limits.maxSummaryCallsPerRun, 'Too many summary calls')
  check(
    evidence.reexecutedToolsPerRun <= limits.maxReexecutedToolsPerRun,
    'Too many re-executed tools'
  )
  check(
    evidence.promptReevaluationsPerRun <= limits.maxPromptReevaluationsPerRun,
    'Too many prompt re-evaluations'
  )
  check(
    positive(evidence.firstTokenMs?.turn1) &&
      evidence.firstTokenMs.turnN / evidence.firstTokenMs.turn1 <= limits.maxTurnNLatencyRatio,
    'Turn N first-token latency regressed'
  )
  return failures
}
