import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataRoot } from './paths'

export type ModelUsageKind = 'builtin' | 'openai-compatible' | 'other'

export type ModelUsageEntry = {
  model: string
  kind: ModelUsageKind
  /** Connection provider hint: ollama | openai | openrouter | … */
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
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
}

type UsageFile = {
  version: 1
  days: Record<string, DayUsage>
}

const KEEP_DAYS = 30

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

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>
): number {
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
  day.models[key] = existing
  day.totalRequests += 1
  day.totalInputTokens += inputTokens
  day.totalOutputTokens += outputTokens
  file.days[date] = day
  saveFile(file)
}

/** Count a Cloud Agent enqueue toward Free-tier daily caps. */
export function recordCloudJobEnqueue(): void {
  const file = loadFile()
  const date = todayKey()
  const day = file.days[date] || emptyDay(date)
  day.cloudJobs = (day.cloudJobs || 0) + 1
  file.days[date] = day
  saveFile(file)
}

function dayList(file: UsageFile): DayUsage[] {
  return Object.keys(file.days)
    .sort()
    .reverse()
    .map((d) => file.days[d]!)
    .filter(Boolean)
}

export function getUsageSnapshot(days = 7): UsageSnapshot {
  const file = loadFile()
  const date = todayKey()
  const today = file.days[date] || emptyDay(date)
  const recent = dayList(file).slice(0, Math.max(1, days))

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

  return { today, days: recent, byKind, byModel }
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
