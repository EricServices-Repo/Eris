import type { DevCapture, DevResult, DevRunHeader } from './eris-dev'

/**
 * Compare two captures by stable question ID (and scripted variant), on the fields
 * where agent-quality regressions occur: route, authority, prompt, model settings,
 * tool schemas, context truncation, obligations and findings. Task UUIDs, temporary
 * paths, timestamps and timings differ between every run and are never counted.
 */
export interface CaptureFieldChange {
  questionId: string
  sourceLine: number
  question: string
  changes: Record<string, { before: unknown; after: unknown; detail?: string }>
}

export type ComparisonCategory =
  'routing' | 'authority' | 'context' | 'model' | 'tools' | 'evaluation'

export interface CaptureComparison {
  matched: number
  added: string[]
  removed: string[]
  changed: CaptureFieldChange[]
  /** Every changed question, independent of how many `changed` rows a caller returns. */
  totalChanged: number
  /** How many matched questions changed each field. */
  byField: Record<string, number>
  /** How many matched questions changed in each category. */
  byCategory: Partial<Record<ComparisonCategory, number>>
  /** Route transitions such as `capability → explore`, with counts. */
  transitions: Record<string, number>
  /** IDs that appear more than once on a side; those records are not compared. */
  duplicates: { before: string[]; after: string[] }
}

export const FIELD_CATEGORY: Record<string, ComparisonCategory> = {
  intent: 'routing',
  agent: 'routing',
  artifact: 'routing',
  status: 'routing',
  authority: 'authority',
  prompt: 'context',
  context: 'context',
  model: 'model',
  sampling: 'model',
  tools: 'tools',
  toolSchemas: 'tools',
  obligations: 'evaluation',
  acceptance: 'evaluation',
  findings: 'evaluation'
}

/** Identifiers that change on every run. */
export function withoutVolatile(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(
      /(?:\/private)?(?:\/var\/folders\/[^\s"'`]+?\/T|\/tmp|[A-Z]:\\[^\s"'`]*?\\Temp)[\\/]+eris-[\w-]+/g,
      '<workspace>'
    )
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?ms\b/g, '<ms>')
}

/** A short, stable, non-cryptographic digest (FNV-1a) for change detection only. */
export function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
        )
      : value

interface Comparable {
  intent: string | null
  agent: string | null
  artifact: string | null
  status: string
  authority: string | null
  /** Canonical messages per request purpose, volatile identifiers removed. */
  prompt: Record<string, string[]>
  /** Context blocks that were truncated or omitted. */
  context: string[]
  model: string[]
  sampling: string[]
  tools: string[]
  /** Normalized parameter schema per tool. */
  toolSchemas: Record<string, string>
  obligations: string[]
  acceptance: string[]
  findings: string[]
}

function agentRequest(record: DevResult): DevCapture | undefined {
  return [...record.requests].reverse().find((request) => request.purpose === 'agent')
}

function toolName(tool: unknown): string | undefined {
  const name = (tool as { function?: { name?: unknown } })?.function?.name
  return typeof name === 'string' ? name : undefined
}

function comparable(record: DevResult): Comparable {
  const task = (record.task ?? {}) as {
    authority?: { tools?: string; edit?: boolean; execute?: string; externalEffects?: boolean }
    interpretation?: { artifact?: string; obligations?: Array<{ text?: string }> }
    acceptanceCriteria?: string[]
  }
  const agent = agentRequest(record)
  const prompt: Record<string, string[]> = {}
  for (const request of record.requests) {
    prompt[request.purpose] = (request.messages as Array<{ role?: string; content?: unknown }>).map(
      (message) =>
        `${message.role ?? '?'}: ${withoutVolatile(
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )}`
    )
  }
  const blocks = ((
    agent?.context as { blocks?: Array<{ kind?: string; status?: string }> } | undefined
  )?.blocks ?? []) as Array<{ kind?: string; status?: string }>
  const toolSchemas: Record<string, string> = {}
  for (const tool of agent?.tools ?? []) {
    const name = toolName(tool)
    if (name)
      toolSchemas[name] = JSON.stringify(sortKeys((tool as { function?: unknown }).function))
  }
  return {
    intent: record.intent ?? null,
    agent: record.agent ?? null,
    artifact: record.artifact ?? task.interpretation?.artifact ?? null,
    status: record.status,
    authority: task.authority
      ? `${task.authority.tools} · edit ${task.authority.edit ? 'yes' : 'no'} · execute ${task.authority.execute} · external ${task.authority.externalEffects ? 'yes' : 'no'}`
      : null,
    prompt,
    context: blocks
      .filter((block) => block.status && block.status !== 'included')
      .map((block) => `${block.kind}:${block.status}`),
    model: record.requests.map((request) => `${request.purpose}:${request.model}`),
    sampling: record.requests.map(
      (request) =>
        `${request.purpose}: temperature ${request.temperature}${request.toolChoice ? ` · tool choice ${request.toolChoice}` : ''}${request.schema ? ` · schema ${digest(sortKeys(request.schema))}` : ''}`
    ),
    tools: Object.keys(toolSchemas).sort(),
    toolSchemas,
    obligations: (task.interpretation?.obligations ?? []).map((item) =>
      withoutVolatile(item.text ?? '')
    ),
    acceptance: (task.acceptanceCriteria ?? []).map(withoutVolatile),
    findings: (record.findingsDetail ?? []).map((finding) => finding.id).sort()
  }
}

/** A short explanation of a prompt or schema change, so the summary need not show both bodies. */
function detailOf(key: keyof Comparable, a: Comparable, b: Comparable): string | undefined {
  if (key === 'prompt') {
    const purposes = [...new Set([...Object.keys(a.prompt), ...Object.keys(b.prompt)])]
    for (const purpose of purposes) {
      const before = a.prompt[purpose] ?? []
      const after = b.prompt[purpose] ?? []
      for (let index = 0; index < Math.max(before.length, after.length); index++) {
        if (before[index] === after[index]) continue
        const left = (before[index] ?? '(absent)').split('\n')
        const right = (after[index] ?? '(absent)').split('\n')
        const line = left.findIndex((text, i) => text !== right[i])
        const at = line < 0 ? left.length : line
        return `${purpose} message ${index + 1}, line ${at + 1}: “${(left[at] ?? '').slice(0, 160)}” → “${(right[at] ?? '').slice(0, 160)}”`
      }
    }
  }
  if (key === 'toolSchemas') {
    const names = [...new Set([...Object.keys(a.toolSchemas), ...Object.keys(b.toolSchemas)])]
    return names
      .filter((name) => a.toolSchemas[name] !== b.toolSchemas[name])
      .map((name) => {
        const required = (schema: string | undefined) =>
          (JSON.parse(schema ?? '{}') as { parameters?: { required?: string[] } }).parameters
            ?.required ?? []
        const lost = required(a.toolSchemas[name]).filter(
          (arg) => !required(b.toolSchemas[name]).includes(arg)
        )
        const gained = required(b.toolSchemas[name]).filter(
          (arg) => !required(a.toolSchemas[name]).includes(arg)
        )
        return `${name}${lost.length ? ` lost required ${lost.join(', ')}` : ''}${gained.length ? ` now requires ${gained.join(', ')}` : ''}`
      })
      .join('; ')
  }
  return undefined
}

/** Summary values: digests for large fields, so a change is visible without its bodies. */
function summaryValue(key: keyof Comparable, value: Comparable[keyof Comparable]): unknown {
  if (key === 'prompt' || key === 'toolSchemas') return digest(value)
  return value
}

const keyOf = (record: DevResult) =>
  record.variant ? `${record.questionId}#${record.variant}` : record.questionId

function byKey(records: DevResult[]): { map: Map<string, DevResult>; duplicates: string[] } {
  const map = new Map<string, DevResult>()
  const duplicates = new Set<string>()
  for (const record of records) {
    const key = keyOf(record)
    if (map.has(key)) duplicates.add(key)
    else map.set(key, record)
  }
  // A duplicated ID cannot be paired reliably; it is reported and left out.
  for (const key of duplicates) map.delete(key)
  return { map, duplicates: [...duplicates] }
}

export function compareCaptures(before: DevResult[], after: DevResult[]): CaptureComparison {
  const previous = byKey(before)
  const next = byKey(after)
  const changed: CaptureFieldChange[] = []
  const byField: Record<string, number> = {}
  const byCategory: CaptureComparison['byCategory'] = {}
  const transitions: Record<string, number> = {}
  let matched = 0
  for (const [id, record] of next.map) {
    const old = previous.map.get(id)
    if (!old) continue
    matched++
    const a = comparable(old)
    const b = comparable(record)
    const changes: CaptureFieldChange['changes'] = {}
    const categories = new Set<ComparisonCategory>()
    for (const key of Object.keys(a) as Array<keyof Comparable>) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue
      const detail = detailOf(key, a, b)
      changes[key] = {
        before: summaryValue(key, a[key]),
        after: summaryValue(key, b[key]),
        ...(detail ? { detail } : {})
      }
      byField[key] = (byField[key] ?? 0) + 1
      categories.add(FIELD_CATEGORY[key]!)
    }
    for (const category of categories) byCategory[category] = (byCategory[category] ?? 0) + 1
    if (changes.intent) {
      const key = `${a.intent ?? 'none'} → ${b.intent ?? 'none'}`
      transitions[key] = (transitions[key] ?? 0) + 1
    }
    if (Object.keys(changes).length)
      changed.push({
        questionId: record.questionId,
        sourceLine: record.sourceLine,
        question: record.question,
        changes
      })
  }
  return {
    matched,
    added: [...next.map.keys()].filter((id) => !previous.map.has(id)),
    removed: [...previous.map.keys()].filter((id) => !next.map.has(id)),
    changed,
    totalChanged: changed.length,
    byField,
    byCategory,
    transitions,
    duplicates: { before: previous.duplicates, after: next.duplicates }
  }
}

/**
 * FR-021: whether two runs differ only in the code under test. A different fixture,
 * corpus, mode, context, resolver script or evaluation version confounds a comparison;
 * a changed app revision or routing/prompt version is the controlled variable.
 */
export interface RunCompatibility {
  status: 'controlled' | 'confounded' | 'legacy'
  /** What differs between the runs that is not the code under test. */
  confounders: string[]
  /** What differs that is the code under test. */
  controlled: string[]
}

export function runCompatibility(
  before: Partial<DevRunHeader> | null,
  after: DevRunHeader
): RunCompatibility {
  if (!before)
    return {
      status: 'legacy',
      confounders: ['The earlier export has no run header; its settings and fixture are unknown.'],
      controlled: []
    }
  const confounders: string[] = []
  if (JSON.stringify(before.memory ?? null) !== JSON.stringify(after.memory ?? null))
    confounders.push('memory episode configuration or labeled corpus changed')
  const controlled: string[] = []
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
  if (differs(before.fixture?.digest, after.fixture.digest))
    confounders.push(
      `fixture changed (${before.fixture?.kind ?? 'unknown'} ${before.fixture?.digest?.slice(0, 8) ?? '—'} → ${after.fixture.kind} ${after.fixture.digest?.slice(0, 8) ?? '—'})`
    )
  if (differs(before.corpus?.id, after.corpus.id)) confounders.push('corpus changed')
  if (differs(before.mode, after.mode)) confounders.push(`mode ${before.mode} → ${after.mode}`)
  if (differs(before.context, after.context))
    confounders.push(`context ${before.context} → ${after.context}`)
  if (differs(before.intentReplyMode, after.intentReplyMode))
    confounders.push(`resolver script ${before.intentReplyMode} → ${after.intentReplyMode}`)
  if (differs(before.settingsDigest, after.settingsDigest))
    confounders.push('capture settings changed')
  if (differs(before.versions?.invariants, after.versions.invariants))
    confounders.push(
      `invariant checker ${before.versions?.invariants ?? 'unrecorded'} → ${after.versions.invariants ?? 'unrecorded'}; findings may differ for identical requests`
    )
  if (differs(before.versions?.schema, after.versions.schema))
    confounders.push(`schema ${before.versions?.schema ?? 'unknown'} → ${after.versions.schema}`)
  if (differs(before.versions?.routing, after.versions.routing))
    controlled.push(`routing ${before.versions?.routing} → ${after.versions.routing}`)
  if (differs(before.versions?.prompt, after.versions.prompt))
    controlled.push(`prompt ${before.versions?.prompt} → ${after.versions.prompt}`)
  if (differs(before.app?.gitSha, after.app.gitSha))
    controlled.push(`source ${before.app?.gitSha?.slice(0, 8)} → ${after.app.gitSha.slice(0, 8)}`)
  return { status: confounders.length ? 'confounded' : 'controlled', confounders, controlled }
}
