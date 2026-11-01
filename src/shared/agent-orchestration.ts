import type { TaskContract } from './task-contract'
/** Minimum characters kept when one agent passes text to another. */
export const AGENT_HANDOFF_CHARS = 8_000

/** Structured handoff between orchestrator and specialist agents. */
export interface AgentHandoffPacket {
  task?: TaskContract
  parentGoal?: string
  goal: string
  summary: string
  /** Must reach the specialist whatever else is cut. Each is short and checkable. */
  constraints?: string[]
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
