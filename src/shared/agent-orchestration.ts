import type { ContextHeader } from './context-memory'
import type { ContextEvidence } from './context-evidence'
import type { TaskContract } from './task-contract'
/** Minimum characters kept when one agent passes text to another. */
export const AGENT_HANDOFF_CHARS = 8_000

/** Bumped when a saved handoff can no longer be read as the current shape. */
export const HANDOFF_VERSION = 1

/** What may be cut. The goal and constraints are refused rather than shortened. */
export type HandoffOptionalField = 'parentGoal' | 'summary' | 'files' | 'openQuestions'

/**
 * One recalled item a handoff may derive from. It names the item and digests its text, so
 * eligibility can be proved again later without keeping private text in the job file.
 */
export interface HandoffEvidenceItem {
  id: string
  sourceId: string
  kind: string
  chars: number
  digest: string
  /** Where the excerpt sits in its source. Absent for pins and receipts. */
  offset?: number
  dependencies?: ContextEvidence
}

/** What a coordinator had seen when it wrote a handoff, and how far that may travel. */
export interface HandoffEvidence {
  root: string | null
  threadId: string
  /** The disclosure ceiling: whether this recall could go to a remote model at all. */
  allowRemote: boolean
  sourceVersion?: ContextHeader
  items: HandoffEvidenceItem[]
}

/** Structured handoff between orchestrator and specialist agents. */
export interface AgentHandoffPacket {
  /** Set by `parseHandoff`. Absent only on a job saved before versions existed. */
  version?: number
  /** Optional fields cut to fit, so a reader knows the handoff is incomplete. */
  truncated?: HandoffOptionalField[]
  task?: TaskContract
  parentGoal?: string
  goal: string
  summary: string
  /** Must reach the specialist whatever else is cut. Each is short and checkable. */
  constraints?: string[]
  /** Set by the runtime, never by the sending agent. See `HandoffEvidence`. */
  evidence?: HandoffEvidence[]
  files?: string[]
  openQuestions?: string[]
  /** 0–1 confidence from the sender */
  confidence?: number
  fromAgentId: string
  toAgentId: string
}

export type BlackboardStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'blocked'
  | 'needs-approval'
  | 'ready-to-merge'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'merged'
  | 'discarded'

export interface AgentRouteStep {
  at: string
  agentId: string
  agentName?: string
  model: string
  reason: string
  kind: 'plan' | 'escalate' | 'reroute' | 'delegate'
}

/** One root's total, however its agents delegate. A run's own step limit resets per agent. */
export const TASK_TREE_LIMITS = { depth: 4, agents: 16, steps: 600, minutes: 60 } as const

export const MAX_HANDOFF_CONSTRAINTS = 12
export const MAX_HANDOFF_CONSTRAINT_CHARS = 300

/** Why these constraints cannot be guaranteed, or null. Refused rather than shortened. */
export function handoffConstraintProblem(constraints: readonly string[]): string | null {
  if (constraints.length > MAX_HANDOFF_CONSTRAINTS)
    return `A handoff carries at most ${MAX_HANDOFF_CONSTRAINTS} constraints, including inherited ones; got ${constraints.length}. Keep the ones that must hold and put the rest in the summary.`
  const long = constraints.find((item) => item.length > MAX_HANDOFF_CONSTRAINT_CHARS)
  return long === undefined
    ? null
    : `Each handoff constraint is at most ${MAX_HANDOFF_CONSTRAINT_CHARS} characters. Shorten: ${long.slice(0, 60)}…`
}

export const HANDOFF_LIMITS = {
  goalChars: AGENT_HANDOFF_CHARS,
  agentIdChars: 128,
  textChars: 16_000,
  files: 64,
  fileChars: 512,
  openQuestions: 16,
  openQuestionChars: 1_000,
  taskChars: 256_000,
  evidenceChars: 256_000
} as const

/** Every field of a task, so a new one has to be added here and nothing unknown is saved. */
const TASK_FIELDS: Record<keyof TaskContract, true> = {
  referenceBinding: true,
  version: true,
  taskId: true,
  parentTaskId: true,
  revision: true,
  threadId: true,
  originalText: true,
  intent: true,
  deliverable: true,
  scope: true,
  authority: true,
  inherited: true,
  skillIds: true,
  recommendations: true,
  recommendationSelection: true,
  acceptanceCriteria: true,
  continuation: true,
  result: true,
  interpretation: true
}

const SHORTENED_NOTE = '\n[Shortened at the handoff limit.]'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A file lead names a place to look. It is a project-relative path, never a grant of access. */
function fileLead(value: string, projectRoot?: string | null): string | null {
  let path = value.trim().replace(/\\/g, '/')
  const root = projectRoot?.replace(/\\/g, '/').replace(/\/$/, '')
  if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1)
  if (!path || path.length > HANDOFF_LIMITS.fileChars || /[\u0000-\u001f]/.test(path)) return null
  if (/^(\/|[a-zA-Z]:|~)/.test(path)) return null
  return path.split('/').includes('..') ? null : path
}

function strings(value: unknown, field: string): { items?: string[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    return { error: `Handoff ${field} must be a list of strings.` }
  return { items: [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))] }
}

function parseTask(value: unknown): { task?: TaskContract; error?: string } {
  if (value === undefined || value === null) return {}
  if (!isRecord(value) || value.version !== 2 || typeof value.taskId !== 'string')
    return { error: 'The handoff task is not a current task contract.' }
  const known = Object.fromEntries(Object.entries(value).filter(([field]) => field in TASK_FIELDS))
  // Serializing is what removes anything live, such as a function or a handle.
  const text = JSON.stringify(known)
  return text.length > HANDOFF_LIMITS.taskChars
    ? { error: 'The handoff task is too large to pass to another agent.' }
    : { task: JSON.parse(text) as TaskContract }
}

function parseEvidenceItem(value: unknown): HandoffEvidenceItem | null {
  if (!isRecord(value)) return null
  const { id, sourceId, kind, chars, digest, offset, dependencies } = value
  if (typeof id !== 'string' || typeof sourceId !== 'string' || typeof kind !== 'string')
    return null
  if (typeof digest !== 'string' || !Number.isSafeInteger(chars)) return null
  if (offset !== undefined && !Number.isSafeInteger(offset)) return null
  return {
    id,
    sourceId,
    kind,
    chars: chars as number,
    digest,
    ...(offset === undefined ? {} : { offset: offset as number }),
    ...(dependencies === undefined ? {} : { dependencies: dependencies as ContextEvidence })
  }
}

/** Evidence that cannot be read is refused: a guard that fails open is not a guard. */
function parseEvidence(value: unknown): { evidence?: HandoffEvidence[]; error?: string } {
  if (value === undefined || value === null) return {}
  const invalid = { error: 'The handoff evidence record is not valid.' }
  if (!Array.isArray(value)) return invalid
  const evidence: HandoffEvidence[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.threadId !== 'string') return invalid
    if (typeof entry.allowRemote !== 'boolean' || !Array.isArray(entry.items)) return invalid
    if (entry.root !== null && typeof entry.root !== 'string') return invalid
    const items = entry.items.map(parseEvidenceItem)
    if (items.some((item) => item === null)) return invalid
    evidence.push({
      root: entry.root,
      threadId: entry.threadId,
      allowRemote: entry.allowRemote,
      ...(isRecord(entry.sourceVersion)
        ? { sourceVersion: entry.sourceVersion as unknown as ContextHeader }
        : {}),
      items: items as HandoffEvidenceItem[]
    })
  }
  return JSON.stringify(evidence).length > HANDOFF_LIMITS.evidenceChars
    ? { error: 'The handoff evidence record is too large to pass to another agent.' }
    : { evidence }
}

export type HandoffParse = { ok: true; packet: AgentHandoffPacket } | { ok: false; error: string }

/**
 * The one reading of a handoff, at the tool, at enqueue and when a saved job loads, so
 * inline and queued specialists get the same packet. Required fields are refused with a
 * reason the sender can act on. Optional ones are cut and listed in `truncated`. Fields
 * not named here are dropped, so nothing else can reach a job file or a prompt. Parsing
 * a parsed packet changes nothing.
 */
export function parseHandoff(input: unknown): HandoffParse {
  const fail = (error: string): HandoffParse => ({ ok: false, error })
  if (!isRecord(input)) return fail('A handoff must be an object.')
  const version = input.version ?? HANDOFF_VERSION
  if (version !== HANDOFF_VERSION)
    return fail(`This handoff is version ${String(version)}; this Eris reads ${HANDOFF_VERSION}.`)

  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (!goal) return fail('A handoff requires a goal.')
  if (goal.length > HANDOFF_LIMITS.goalChars)
    return fail(
      `A handoff goal is at most ${HANDOFF_LIMITS.goalChars} characters; got ${goal.length}. State the goal briefly and put the detail in the summary.`
    )
  for (const field of ['fromAgentId', 'toAgentId'] as const) {
    const id = input[field]
    if (typeof id !== 'string' || !id.trim() || id.length > HANDOFF_LIMITS.agentIdChars)
      return fail(`A handoff requires a valid ${field}.`)
  }
  const { confidence } = input
  if (
    confidence !== undefined &&
    confidence !== null &&
    (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))
  )
    return fail('Handoff confidence must be a number from 0 to 1.')

  const constraints = strings(input.constraints, 'constraints')
  const files = strings(input.files, 'files')
  const openQuestions = strings(input.openQuestions, 'openQuestions')
  const failed = constraints.error ?? files.error ?? openQuestions.error
  if (failed) return fail(failed)
  const constraintProblem = handoffConstraintProblem(constraints.items ?? [])
  if (constraintProblem) return fail(constraintProblem)
  const { task, error: taskError } = parseTask(input.task)
  if (taskError) return fail(taskError)
  const { evidence, error: evidenceError } = parseEvidence(input.evidence)
  if (evidenceError) return fail(evidenceError)

  const cut = new Set<HandoffOptionalField>(
    Array.isArray(input.truncated)
      ? input.truncated.filter((field): field is HandoffOptionalField =>
          ['parentGoal', 'summary', 'files', 'openQuestions'].includes(field)
        )
      : []
  )
  const bounded = (value: string, field: HandoffOptionalField) => {
    if (value.length <= HANDOFF_LIMITS.textChars) return value
    cut.add(field)
    return value.slice(0, HANDOFF_LIMITS.textChars - SHORTENED_NOTE.length) + SHORTENED_NOTE
  }

  const leads = (files.items ?? []).map((file) => fileLead(file, task?.scope.projectRoot))
  const kept = [...new Set(leads.filter((file): file is string => file !== null))]
  if (kept.length < leads.length || kept.length > HANDOFF_LIMITS.files) cut.add('files')
  const questions = openQuestions.items ?? []
  const shortQuestions = questions.filter((q) => q.length <= HANDOFF_LIMITS.openQuestionChars)
  if (
    shortQuestions.length < questions.length ||
    shortQuestions.length > HANDOFF_LIMITS.openQuestions
  )
    cut.add('openQuestions')

  const parentGoal = typeof input.parentGoal === 'string' ? input.parentGoal : undefined
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary : goal
  const packet: AgentHandoffPacket = {
    version: HANDOFF_VERSION,
    ...(task ? { task } : {}),
    ...(parentGoal !== undefined ? { parentGoal: bounded(parentGoal, 'parentGoal') } : {}),
    goal,
    summary: bounded(summary, 'summary'),
    ...(constraints.items ? { constraints: constraints.items } : {}),
    ...(evidence ? { evidence } : {}),
    ...(files.items ? { files: kept.slice(0, HANDOFF_LIMITS.files) } : {}),
    ...(openQuestions.items
      ? { openQuestions: shortQuestions.slice(0, HANDOFF_LIMITS.openQuestions) }
      : {}),
    ...(typeof confidence === 'number' ? { confidence } : {}),
    fromAgentId: input.fromAgentId as string,
    toAgentId: input.toAgentId as string,
    ...(cut.size ? { truncated: [...cut] } : {})
  }
  return { ok: true, packet }
}

/**
 * The optional part of a handoff, which may be cut under a tight budget. The goal, the
 * parent request and the constraints are in the task contract, which never is.
 */
export function formatHandoffBriefing(packet: AgentHandoffPacket): string {
  const lines = [
    `[Eris handoff → ${packet.toAgentId}]`,
    `From: ${packet.fromAgentId}`,
    `You are a specialist working for ${packet.fromAgentId}, not answering the user. Complete only the goal in your task contract, within the task's project and tool ceiling, and return the requested evidence to your coordinator: what you inspected or changed, with paths, and anything left unresolved.`,
    `Summary: ${packet.summary}`
  ]
  if (packet.files?.length) lines.push(`Files: ${packet.files.join(', ')}`)
  if (packet.openQuestions?.length)
    lines.push(`Open questions:\n${packet.openQuestions.map((q) => `- ${q}`).join('\n')}`)
  if (packet.confidence != null) lines.push(`Confidence: ${packet.confidence}`)
  if (packet.truncated?.length)
    lines.push(`Incomplete: ${packet.truncated.join(', ')} cut at the handoff limit.`)
  return lines.join('\n')
}

/** One message shape for a specialist, whether it runs inline or as a background job. */
export const handoffMessages = (packet: AgentHandoffPacket) => [
  { role: 'system' as const, content: formatHandoffBriefing(packet) },
  { role: 'user' as const, content: packet.goal }
]

/** The whole packet, for routing and for showing a job's result in chat. */
export function formatHandoffForPrompt(packet: AgentHandoffPacket): string {
  const lines = [
    `[Eris handoff → ${packet.toAgentId}]`,
    `From: ${packet.fromAgentId}`,
    `You are a specialist working for ${packet.fromAgentId}, not answering the user. Complete only the goal below, within the task's project and tool ceiling, and return the requested evidence to your coordinator: what you inspected or changed, with paths, and anything left unresolved.`,
    packet.parentGoal ? `Parent request: ${packet.parentGoal}` : '',
    `Goal: ${packet.goal}`,
    packet.task
      ? `Task ${packet.task.taskId} · scope ${packet.task.scope.projectRoot} · tools ${packet.task.authority.tools}`
      : '',
    `Summary: ${packet.summary}`
  ]
  if (packet.constraints?.length)
    lines.push(`Constraints:\n${packet.constraints.map((item) => `- ${item}`).join('\n')}`)
  if (packet.files?.length) lines.push(`Files: ${packet.files.join(', ')}`)
  if (packet.openQuestions?.length) {
    lines.push(`Open questions:\n${packet.openQuestions.map((q) => `- ${q}`).join('\n')}`)
  }
  if (packet.confidence != null) lines.push(`Confidence: ${packet.confidence}`)
  return lines.join('\n')
}

export function formatJobResultForChat(options: {
  goal: string
  agentName?: string
  status: string
  answer: string
  filesTouched: string[]
  routeReason?: string
  handoff?: AgentHandoffPacket | null
}): string {
  const header = [
    `### Background agent result`,
    `**Status:** ${options.status}`,
    options.agentName ? `**Agent:** ${options.agentName}` : '',
    `**Goal:** ${options.goal}`,
    options.routeReason ? `**Route:** ${options.routeReason}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const files =
    options.filesTouched.length > 0
      ? `\n\n**Files touched:**\n${options.filesTouched.map((f) => `- ${f}`).join('\n')}`
      : ''

  const handoff = options.handoff
    ? `\n\n**Handoff**\n${formatHandoffForPrompt(options.handoff)}`
    : ''

  const answer = options.answer.trim()
    ? `\n\n${options.answer.trim()}`
    : '\n\n_(no answer text — check the Agents inbox diff)_'

  return `${header}${files}${handoff}${answer}`
}

export function deriveBlackboardStatus(job: {
  status: string
  liveStatus?: string | null
  waitReason?: 'children' | 'approval' | 'question' | null
}): BlackboardStatus {
  if (job.status === 'queued') return 'queued'
  if (job.status === 'merged') return 'merged'
  if (job.status === 'discarded') return 'discarded'
  if (job.status === 'stopped') return 'stopped'
  if (job.status === 'failed') return 'failed'
  if (job.status === 'done') return 'ready-to-merge'
  if (job.waitReason === 'approval') return 'needs-approval'
  if (job.waitReason === 'children' || job.waitReason === 'question') return 'blocked'
  if (job.status === 'running') return 'running'
  return 'queued'
}

/** Child completion is a result, not merely the absence of running jobs. */
export function summarizeAgentResults(
  children: Array<
    | {
        id: string
        agentId: string
        agentName?: string
        status: string
        answer: string
        error?: string
        filesTouched?: string[]
      }
    | undefined
  >
): { ok: boolean; detail: string } {
  return {
    ok: children.every((child) => child && ['done', 'merged'].includes(child.status)),
    detail: children
      .map((child) => {
        if (!child) return 'Missing specialist result. The assignment remains unresolved.'
        return [
          `### ${child.agentName || child.agentId} · ${child.status} · ${child.id}`,
          child.error ? `Error: ${child.error}` : '',
          child.filesTouched?.length ? `Files: ${child.filesTouched.join(', ')}` : '',
          child.answer.trim().slice(0, AGENT_HANDOFF_CHARS) || '(no answer)',
          child.status === 'done' && child.filesTouched?.length
            ? 'Inspect the reported changes. If they are in a separate worktree, merge/apply them before claiming they are in the user workspace.'
            : ''
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n\n')
  }
}
