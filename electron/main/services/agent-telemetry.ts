import { routingEvidenceKey, ROUTING_EVIDENCE_MAX_AGE_MS } from './routing-evidence'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'
import type { ChatIntent } from '../../../src/shared/settings-schema'
import {
  bestTelemetryModelForIntent,
  emptyOutcome,
  summarizeOutcome,
  type AgentOutcomeRecord,
  type AgentOutcomeSummary
} from '../../../src/shared/agent-telemetry'

/**
 * Opt-in local store of real agent-run outcomes. Never contains code or prompts —
 * only model, intent and counts. Fed into routing and shown in Settings → Usage.
 */
type TelemetryFile = {
  version: 1
  records: Record<string, AgentOutcomeRecord>
}

function telemetryPath(): string {
  return join(userDataRoot(), 'agent-telemetry.json')
}

function key(model: string, intent: ChatIntent): string {
  return `${model}::${intent}`
}

function load(): TelemetryFile {
  const path = telemetryPath()
  if (!existsSync(path)) return { version: 1, records: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as TelemetryFile
    if (!raw || typeof raw !== 'object' || !raw.records) return { version: 1, records: {} }
    return { version: 1, records: raw.records }
  } catch {
    return { version: 1, records: {} }
  }
}

function save(file: TelemetryFile): void {
  try {
    mkdirSync(userDataRoot(), { recursive: true })
    writeFileSync(telemetryPath(), JSON.stringify(file, null, 2), 'utf8')
  } catch {
    /* telemetry is best-effort */
  }
}

/** The last agent run's attribution, so diff keep/undo can be credited to it. */
let lastRunContext: { model: string; intent: ChatIntent } | null = null

export function noteAgentRunContext(model: string, intent: ChatIntent): void {
  lastRunContext = { model, intent }
}

function mutate(
  model: string,
  intent: ChatIntent,
  fn: (r: AgentOutcomeRecord) => void
): void {
  if (!model) return
  const file = load()
  const k = key(model, intent)
  const rec = file.records[k] ?? emptyOutcome(model, intent)
  fn(rec)
  file.records[k] = rec
  save(file)
}

export function recordAgentRun(input: {
  model: string
  intent: ChatIntent
  steps: number
  mutated: boolean
  incomplete: boolean
  aborted: boolean
  settings?: AppSettings
}): void {
  noteAgentRunContext(input.model, input.intent)
  mutate(input.model, input.intent, (r) => {
    if (input.settings) {
      const key = routingEvidenceKey(input.settings, input.model)
      if (r.routingKey !== key || !r.updatedAt || Date.now() - r.updatedAt > ROUTING_EVIDENCE_MAX_AGE_MS) Object.assign(r, emptyOutcome(input.model, input.intent))
      r.routingKey = key
      r.updatedAt = Date.now()
    }
    r.runs += 1
    r.totalSteps += Math.max(0, Math.round(input.steps))
    if (input.aborted) r.aborted += 1
    else if (input.incomplete) r.incomplete += 1
    else r.succeeded += 1
  })
}

/** Credit the user's Keep/Undo decisions to the last agent run's model + intent. */
export function recordDiffDecision(input: { kept?: number; undone?: number }): void {
  const ctx = lastRunContext
  if (!ctx) return
  mutate(ctx.model, ctx.intent, (r) => {
    r.kept += Math.max(0, Math.round(input.kept || 0))
    r.undone += Math.max(0, Math.round(input.undone || 0))
  })
}

export function getTelemetryRecords(): AgentOutcomeRecord[] {
  return Object.values(load().records)
}

export function getTelemetrySummaries(): AgentOutcomeSummary[] {
  return getTelemetryRecords()
    .map(summarizeOutcome)
    .sort((a, b) => b.runs - a.runs)
}

export function bestModelForIntent(
  intent: ChatIntent,
  candidates: string[],
  minRuns: number,
  settings?: AppSettings
): string | null {
  const eligible = new Set(candidates)
  const records = getTelemetryRecords().filter((r) => eligible.has(r.model) && (!settings || (
    r.routingKey === routingEvidenceKey(settings, r.model) &&
    typeof r.updatedAt === 'number' && Date.now() - r.updatedAt <= ROUTING_EVIDENCE_MAX_AGE_MS
  )))
  return bestTelemetryModelForIntent(records, intent, candidates, minRuns)
}

export function clearTelemetry(): void {
  save({ version: 1, records: {} })
}
