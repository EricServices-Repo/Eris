import type { ChatIntent } from './settings-schema'

/**
 * Real-usage telemetry for the agent — how runs actually turn out in the user's
 * workspace, as opposed to the eval harness's synthetic tasks. Opt-in. Used as a
 * routing signal alongside eval scores, and shown in Settings → Usage.
 */
export type AgentOutcomeRecord = {
  model: string
  intent: ChatIntent
  /** Agent runs that reached a terminal state. */
  runs: number
  /** Runs that finished without hitting a safety budget and that changed files. */
  succeeded: number
  /** Runs that stopped at a step/verify budget before finishing. */
  incomplete: number
  /** Runs the user aborted. */
  aborted: number
  /** Sum of steps across runs (for avg). */
  totalSteps: number
  /** Diffs the user kept. */
  kept: number
  /** Diffs the user undid. */
  undone: number
}

export type AgentOutcomeSummary = AgentOutcomeRecord & {
  /** succeeded / runs. */
  successRate: number
  /** totalSteps / runs. */
  avgSteps: number
  /** kept / (kept + undone); 1 when no decisions recorded yet. */
  keepRate: number
}

export function emptyOutcome(model: string, intent: ChatIntent): AgentOutcomeRecord {
  return {
    model,
    intent,
    runs: 0,
    succeeded: 0,
    incomplete: 0,
    aborted: 0,
    totalSteps: 0,
    kept: 0,
    undone: 0
  }
}

export function summarizeOutcome(r: AgentOutcomeRecord): AgentOutcomeSummary {
  const decisions = r.kept + r.undone
  return {
    ...r,
    successRate: r.runs > 0 ? r.succeeded / r.runs : 0,
    avgSteps: r.runs > 0 ? r.totalSteps / r.runs : 0,
    keepRate: decisions > 0 ? r.kept / decisions : 1
  }
}

/**
 * Pick the model with the best real-world outcome for an intent, among ready
 * candidates with enough runs. Ranks by a blended score (success rate weighted
 * by keep rate), then fewer average steps. Returns null when nothing qualifies,
 * so the caller can fall back to eval scores or the user's selection.
 */
export function bestTelemetryModelForIntent(
  records: AgentOutcomeRecord[],
  intent: ChatIntent,
  candidates: string[],
  minRuns: number
): string | null {
  const ready = new Set(candidates.filter(Boolean))
  if (ready.size === 0) return null
  const ranked = records
    .filter((r) => r.intent === intent && ready.has(r.model) && r.runs >= minRuns)
    .map((r) => {
      const s = summarizeOutcome(r)
      return { model: r.model, score: s.successRate * (0.5 + 0.5 * s.keepRate), avgSteps: s.avgSteps }
    })
    .sort((a, b) => b.score - a.score || a.avgSteps - b.avgSteps)
  const top = ranked[0]
  if (!top || top.score <= 0) return null
  return top.model
}
