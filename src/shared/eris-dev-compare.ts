import type { DevResult } from './eris-dev'

/**
 * Compare two captures by stable question ID, on the fields that mean something:
 * route, artifact, authority, tools and findings. Task UUIDs, temporary paths and
 * timings differ between every run and are never counted as changes.
 */
export interface CaptureFieldChange {
  questionId: string
  sourceLine: number
  question: string
  changes: Record<string, { before: unknown; after: unknown }>
}

export interface CaptureComparison {
  matched: number
  added: string[]
  removed: string[]
  changed: CaptureFieldChange[]
  /** How many matched questions changed each field. */
  byField: Record<string, number>
  /** Route transitions such as `capability → explore`, with counts. */
  transitions: Record<string, number>
}

interface Comparable {
  intent: string | null
  agent: string | null
  artifact: string | null
  authority: string | null
  tools: string[]
  findings: string[]
  status: string
}

function toolNames(record: DevResult): string[] {
  const agent = [...record.requests].reverse().find((request) => request.purpose === 'agent')
  return (agent?.tools ?? [])
    .map((tool) => (tool as { function?: { name?: string } })?.function?.name)
    .filter((name): name is string => typeof name === 'string')
    .sort()
}

function comparable(record: DevResult): Comparable {
  const task = (record.task ?? {}) as {
    authority?: { tools?: string; edit?: boolean; execute?: string }
    interpretation?: { artifact?: string }
  }
  return {
    intent: record.intent ?? null,
    agent: record.agent ?? null,
    artifact: record.artifact ?? task.interpretation?.artifact ?? null,
    authority: task.authority
      ? `${task.authority.tools} · edit ${task.authority.edit ? 'yes' : 'no'} · execute ${task.authority.execute}`
      : null,
    tools: toolNames(record),
    findings: (record.findingsDetail ?? []).map((finding) => finding.id).sort(),
    status: record.status
  }
}

export function compareCaptures(before: DevResult[], after: DevResult[]): CaptureComparison {
  const previous = new Map(before.map((record) => [record.questionId, record]))
  const next = new Map(after.map((record) => [record.questionId, record]))
  const changed: CaptureFieldChange[] = []
  const byField: Record<string, number> = {}
  const transitions: Record<string, number> = {}
  let matched = 0
  for (const [id, record] of next) {
    const old = previous.get(id)
    if (!old) continue
    matched++
    const a = comparable(old)
    const b = comparable(record)
    const changes: CaptureFieldChange['changes'] = {}
    for (const key of Object.keys(a) as Array<keyof Comparable>) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        changes[key] = { before: a[key], after: b[key] }
        byField[key] = (byField[key] ?? 0) + 1
      }
    }
    if (changes.intent) {
      const key = `${a.intent ?? 'none'} → ${b.intent ?? 'none'}`
      transitions[key] = (transitions[key] ?? 0) + 1
    }
    if (Object.keys(changes).length)
      changed.push({ questionId: id, sourceLine: record.sourceLine, question: record.question, changes })
  }
  return {
    matched,
    added: [...next.keys()].filter((id) => !previous.has(id)),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    changed,
    byField,
    transitions
  }
}
