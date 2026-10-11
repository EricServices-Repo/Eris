import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ChatIntent } from '../../../src/shared/settings-schema'
import { userDataRoot } from './paths'

export interface RoutingCorrection {
  at: string
  text: string
  /** Intent the router picked */
  from: ChatIntent
  /** What the user said it should have been */
  to: 'tools' | 'answer'
  agentId: string
}

const MAX_SCAN = 400

function feedbackPath(): string {
  return join(userDataRoot(), 'routing-feedback.jsonl')
}

export function normalizeRoutingText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400)
}

export function recordRoutingCorrection(entry: Omit<RoutingCorrection, 'at'>): void {
  try {
    mkdirSync(userDataRoot(), { recursive: true })
    const row: RoutingCorrection = { ...entry, at: new Date().toISOString(), text: entry.text.slice(0, 400) }
    appendFileSync(feedbackPath(), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    // feedback is best-effort
  }
}

export function readRoutingCorrections(limit = MAX_SCAN): RoutingCorrection[] {
  const path = feedbackPath()
  if (!existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').slice(-limit)
    const out: RoutingCorrection[] = []
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as RoutingCorrection
        if (row && typeof row.text === 'string' && (row.to === 'tools' || row.to === 'answer')) {
          out.push(row)
        }
      } catch {
        // skip bad line
      }
    }
    return out
  } catch {
    return []
  }
}

/** Most recent correction for the exact same message, if any. */
export function learnedRouteFor(
  text: string,
  corrections: RoutingCorrection[] = readRoutingCorrections()
): 'tools' | 'answer' | null {
  const norm = normalizeRoutingText(text)
  if (!norm) return null
  for (let i = corrections.length - 1; i >= 0; i--) {
    if (normalizeRoutingText(corrections[i]!.text) === norm) return corrections[i]!.to
  }
  return null
}

/** Few-shot lines for the LLM router prompt. */
export function routingExamples(corrections: RoutingCorrection[], max = 8): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (let i = corrections.length - 1; i >= 0 && lines.length < max; i--) {
    const c = corrections[i]!
    const key = normalizeRoutingText(c.text)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(
      `- "${c.text.slice(0, 160).replace(/"/g, "'")}" → ${c.to === 'answer' ? 'answer (no tools)' : 'needs workspace tools'}`
    )
  }
  return lines.join('\n')
}
