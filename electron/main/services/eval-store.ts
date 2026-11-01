import type { AppSettings } from '../../../src/shared/settings-schema'
import { routingEvidenceKey, ROUTING_EVIDENCE_MAX_AGE_MS } from './routing-evidence'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChatIntent } from '../../../src/shared/settings-schema'
import type { EvalResult, EvalScore, EvalScoreboard } from '../../../src/shared/evals'
import { userDataRoot } from './paths'

const MAX_RESULTS = 400

interface Store {
  results: EvalResult[]
}

function storePath(): string {
  return join(userDataRoot(), 'eval-results.json')
}

function readStore(): Store {
  try {
    if (!existsSync(storePath())) return { results: [] }
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as Partial<Store>
    return { results: Array.isArray(raw.results) ? raw.results : [] }
  } catch {
    return { results: [] }
  }
}

function writeStore(store: Store): void {
  mkdirSync(userDataRoot(), { recursive: true })
  writeFileSync(storePath(), JSON.stringify({ results: store.results.slice(-MAX_RESULTS) }, null, 2), 'utf8')
}

export function appendEvalResults(results: EvalResult[]): void {
  if (results.length === 0) return
  const store = readStore()
  store.results.push(...results)
  writeStore(store)
}

export function listEvalResults(limit = 80): EvalResult[] {
  return readStore().results.slice(-limit)
}

export function clearEvalResults(): void {
  writeStore({ results: [] })
}

export function scoreEvalResults(results: EvalResult[] = readStore().results): EvalScore[] {
  const buckets = new Map<string, { model: string; intent: ChatIntent; runs: number; passed: number; steps: number; duration: number }>()
  for (const r of results) {
    const key = `${r.model}\0${r.intent}`
    const cur = buckets.get(key) ?? {
      model: r.model,
      intent: r.intent,
      runs: 0,
      passed: 0,
      steps: 0,
      duration: 0
    }
    cur.runs += 1
    if (r.ok) cur.passed += 1
    cur.steps += r.steps
    cur.duration += r.durationMs
    buckets.set(key, cur)
  }
  return [...buckets.values()]
    .map((b) => ({
      model: b.model,
      intent: b.intent,
      runs: b.runs,
      passed: b.passed,
      successRate: b.runs === 0 ? 0 : b.passed / b.runs,
      avgSteps: b.runs === 0 ? 0 : b.steps / b.runs,
      avgDurationMs: b.runs === 0 ? 0 : b.duration / b.runs
    }))
    .sort((a, b) => b.successRate - a.successRate || b.runs - a.runs)
}

export function getEvalScoreboard(): EvalScoreboard {
  const results = readStore().results
  return {
    scores: scoreEvalResults(results),
    recent: results.slice(-40).reverse(),
    totalRuns: results.length
  }
}

/** Best-scoring model for an intent among `candidates`, or null if too few runs. */
export function bestEvalModelForIntent(
  intent: ChatIntent,
  candidates: string[],
  minRuns: number,
  results?: EvalResult[],
  settings?: AppSettings
): string | null {
  const ready = new Set(candidates.filter(Boolean))
  if (ready.size === 0) return null
  const fresh = settings ? (results ?? readStore().results).filter((r) =>
    r.routingKey === routingEvidenceKey(settings, r.model) &&
    Number.isFinite(Date.parse(r.at)) && Date.now() - Date.parse(r.at) <= ROUTING_EVIDENCE_MAX_AGE_MS
  ) : results
  const ranked = scoreEvalResults(fresh).filter(
    (s) => s.intent === intent && ready.has(s.model) && s.runs >= minRuns
  )
  if (ranked.length === 0) return null
  ranked.sort((a, b) => b.successRate - a.successRate || a.avgSteps - b.avgSteps)
  const top = ranked[0]
  if (!top || top.successRate <= 0) return null
  return top.model
}
