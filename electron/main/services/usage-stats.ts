import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'

function notifyProfileUsageDelta(delta: {
  requests?: number
  inputTokens?: number
  outputTokens?: number
  cloudJobs?: number
}): void {
  // Dynamic import avoids a circular dependency with usage-sync.ts
  void import('./usage-sync').then((m) => m.queueUsageDelta(delta)).catch(() => undefined)
}

export type ModelUsageKind = 'builtin' | 'openai-compatible' | 'other'

export type ModelUsageEntry = {
  model: string
  kind: ModelUsageKind
  /** Connection provider hint: ollama | openai | openrouter | … */
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  measuredInputTokens?: number
  measuredOutputTokens?: number
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
}

export type DayUsage = {
  date: string
  models: Record<string, ModelUsageEntry>
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  /** Cloud Agent jobs enqueued today (Free tier capped). */
  cloudJobs?: number
}

export type UsageSnapshot = {
  today: DayUsage
  days: DayUsage[]
  byKind: Array<{
    kind: ModelUsageKind
    label: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  byModel: Array<ModelUsageEntry & { totalTokens: number; share: number }>
  entitlement?: import('./eris-entitlements').UsageEntitlement
  /** Rolling allowance window (always the last USAGE_WINDOW_DAYS, not the chart length). */
  window?: UsageWindowTotals
}

type UsageFile = {
  version: 1
  days: Record<string, DayUsage>
}

const KEEP_DAYS = 30

/** Allowance and the usage chart cover this many calendar days, ending today. */
export const USAGE_WINDOW_DAYS = 30

function usagePath(): string {
  return join(userDataRoot(), 'usage.json')
}

function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyDay(date: string): DayUsage {
  return {
    date,
    models: {},
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cloudJobs: 0
  }
}

function loadFile(): UsageFile {
  const path = usagePath()
  if (!existsSync(path)) return { version: 1, days: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as UsageFile
    if (!raw || typeof raw !== 'object' || !raw.days) return { version: 1, days: {} }
    return { version: 1, days: raw.days }
  } catch {
    return { version: 1, days: {} }
  }
}

function prune(file: UsageFile): UsageFile {
  const keys = Object.keys(file.days).sort()
  if (keys.length <= KEEP_DAYS) return file
  const drop = keys.slice(0, keys.length - KEEP_DAYS)
  for (const k of drop) delete file.days[k]
  return file
}

function saveFile(file: UsageFile): void {
  mkdirSync(userDataRoot(), { recursive: true })
  writeFileSync(usagePath(), JSON.stringify(prune(file), null, 2), 'utf8')
}

/** Rough token estimate when providers don't report usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content || '') + 4
  }
  return total
}

function kindLabel(kind: ModelUsageKind): string {
  if (kind === 'builtin') return 'Built-in Composer'
  if (kind === 'openai-compatible') return 'OpenAI-compatible'
  return 'Other'
}

export function classifyModel(
  model: string,
  provider?: string | null
): { kind: ModelUsageKind; provider: string } {
  if (model.startsWith('builtin:')) {
    return { kind: 'builtin', provider: 'builtin' }
  }
  const p = (provider || 'custom').trim() || 'custom'
  return { kind: 'openai-compatible', provider: p }
}

export function recordModelUsage(options: {
  inputSource?: 'measured' | 'estimated'
  outputSource?: 'measured' | 'estimated'
  model: string
  provider?: string | null
  inputTokens: number
  outputTokens: number
}): void {
  const model = (options.model || 'unknown').trim() || 'unknown'
  const { kind, provider } = classifyModel(model, options.provider)
  const inputTokens = Math.max(0, Math.round(options.inputTokens) || 0)
  const outputTokens = Math.max(0, Math.round(options.outputTokens) || 0)
  if (inputTokens === 0 && outputTokens === 0) return

  const file = loadFile()
  const date = todayKey()
  const day = file.days[date] || emptyDay(date)
  const key = `${kind}::${provider}::${model}`
  const existing = day.models[key] || {
    model,
    kind,
    provider,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0
  }
  existing.requests += 1
  existing.inputTokens += inputTokens
  existing.outputTokens += outputTokens
  const inputField =
    options.inputSource === 'measured' ? 'measuredInputTokens' : 'estimatedInputTokens'
  const outputField =
    options.outputSource === 'measured' ? 'measuredOutputTokens' : 'estimatedOutputTokens'
  existing[inputField] = (existing[inputField] ?? 0) + inputTokens
  existing[outputField] = (existing[outputField] ?? 0) + outputTokens
  day.models[key] = existing
  day.totalRequests += 1
  day.totalInputTokens += inputTokens
  day.totalOutputTokens += outputTokens
  file.days[date] = day
  saveFile(file)
  notifyProfileUsageDelta({
    requests: 1,
    inputTokens,
    outputTokens,
    cloudJobs: 0
  })
}

/** Count a Cloud Agent enqueue toward the Free-tier rolling window. */
export function recordCloudJobEnqueue(): void {
  const file = loadFile()
  const date = todayKey()
  const day = file.days[date] || emptyDay(date)
  day.cloudJobs = (day.cloudJobs || 0) + 1
  file.days[date] = day
  saveFile(file)
  notifyProfileUsageDelta({ cloudJobs: 1 })
}

export type DayUsageTotals = {
  requests: number
  inputTokens: number
  outputTokens: number
  cloudJobs: number
}

/** Oldest → newest calendar keys ending on `end` (local timezone). */
export function rollingDayKeys(count = USAGE_WINDOW_DAYS, end = new Date()): string[] {
  const n = Math.max(1, Math.round(count))
  const keys: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)
    keys.push(todayKey(d))
  }
  return keys
}

export function sumDayTotals(parts: DayUsageTotals[]): DayUsageTotals {
  const totals: DayUsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cloudJobs: 0
  }
  for (const part of parts) {
    totals.requests += part.requests || 0
    totals.inputTokens += part.inputTokens || 0
    totals.outputTokens += part.outputTokens || 0
    totals.cloudJobs += part.cloudJobs || 0
  }
  return totals
}

export function getLocalDayTotals(date = todayKey()): DayUsageTotals {
  const file = loadFile()
  const day = file.days[date] || emptyDay(date)
  return {
    requests: day.totalRequests || 0,
    inputTokens: day.totalInputTokens || 0,
    outputTokens: day.totalOutputTokens || 0,
    cloudJobs: day.cloudJobs || 0
  }
}

/**
 * Merge remote profile day into local file (max per counter) so UI matches Control Hub.
 */
export function applyRemoteDayUsage(remote: {
  day: string
  requests: number
  inputTokens: number
  outputTokens: number
  cloudJobs: number
}): void {
  if (!remote?.day) return
  const file = loadFile()
  const day = file.days[remote.day] || emptyDay(remote.day)
  const nextRequests = Math.max(day.totalRequests || 0, remote.requests || 0)
  const nextIn = Math.max(day.totalInputTokens || 0, remote.inputTokens || 0)
  const nextOut = Math.max(day.totalOutputTokens || 0, remote.outputTokens || 0)
  const nextCloud = Math.max(day.cloudJobs || 0, remote.cloudJobs || 0)
  if (
    nextRequests === (day.totalRequests || 0) &&
    nextIn === (day.totalInputTokens || 0) &&
    nextOut === (day.totalOutputTokens || 0) &&
    nextCloud === (day.cloudJobs || 0)
  ) {
    return
  }
  // Bump aggregate totals only — per-model breakdown stays local-device detail.
  day.totalRequests = nextRequests
  day.totalInputTokens = nextIn
  day.totalOutputTokens = nextOut
  day.cloudJobs = nextCloud
  file.days[remote.day] = day
  saveFile(file)
}

export function getLocalWindowTotals(windowDays = USAGE_WINDOW_DAYS): DayUsageTotals & {
  from: string
  to: string
  days: number
} {
  const keys = rollingDayKeys(windowDays)
  const file = loadFile()
  const totals = sumDayTotals(
    keys.map((key) => {
      const day = file.days[key]
      return {
        requests: day?.totalRequests || 0,
        inputTokens: day?.totalInputTokens || 0,
        outputTokens: day?.totalOutputTokens || 0,
        cloudJobs: day?.cloudJobs || 0
      }
    })
  )
  return {
    ...totals,
    from: keys[0] || todayKey(),
    to: keys[keys.length - 1] || todayKey(),
    days: keys.length
  }
}

export type UsageWindowTotals = DayUsageTotals & {
  from: string
  to: string
  days: number
}

export function getUsageSnapshot(days = USAGE_WINDOW_DAYS): UsageSnapshot {
  const file = loadFile()
  const date = todayKey()
  const today = file.days[date] || emptyDay(date)
  const keys = [...rollingDayKeys(days)].reverse()
  const recent = keys.map((key) => file.days[key] || emptyDay(key))
  const window = getLocalWindowTotals()

  const kindMap = new Map<
    ModelUsageKind,
    { requests: number; inputTokens: number; outputTokens: number }
  >()
  for (const entry of Object.values(today.models)) {
    const cur = kindMap.get(entry.kind) || {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0
    }
    cur.requests += entry.requests
    cur.inputTokens += entry.inputTokens
    cur.outputTokens += entry.outputTokens
    kindMap.set(entry.kind, cur)
  }

  const byKind = (['builtin', 'openai-compatible', 'other'] as ModelUsageKind[])
    .map((kind) => {
      const cur = kindMap.get(kind) || {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0
      }
      return {
        kind,
        label: kindLabel(kind),
        requests: cur.requests,
        inputTokens: cur.inputTokens,
        outputTokens: cur.outputTokens,
        totalTokens: cur.inputTokens + cur.outputTokens
      }
    })
    .filter((k) => k.totalTokens > 0 || k.requests > 0)

  const totalToday = today.totalInputTokens + today.totalOutputTokens
  const byModel = Object.values(today.models)
    .map((m) => {
      const totalTokens = m.inputTokens + m.outputTokens
      return {
        ...m,
        totalTokens,
        share: totalToday > 0 ? totalTokens / totalToday : 0
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)

  return { today, days: recent, byKind, byModel, window }
}

export function clearUsageStats(options?: { todayOnly?: boolean }): UsageSnapshot {
  if (options?.todayOnly) {
    const file = loadFile()
    delete file.days[todayKey()]
    saveFile(file)
  } else {
    saveFile({ version: 1, days: {} })
  }
  return getUsageSnapshot()
}
