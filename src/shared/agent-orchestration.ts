/** Minimum characters kept when one agent passes text to another. */
export const AGENT_HANDOFF_CHARS = 8_000

/** Structured handoff between orchestrator and specialist agents. */
export interface AgentHandoffPacket {
  goal: string
  summary: string
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

export function formatHandoffForPrompt(packet: AgentHandoffPacket): string {
  const lines = [
    `[Eris handoff → ${packet.toAgentId}]`,
    `From: ${packet.fromAgentId}`,
    `Goal: ${packet.goal}`,
    `Summary: ${packet.summary}`
  ]
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
}): BlackboardStatus {
  const live = (job.liveStatus || '').toLowerCase()
  if (job.status === 'queued') return 'queued'
  if (job.status === 'merged') return 'merged'
  if (job.status === 'discarded') return 'discarded'
  if (job.status === 'stopped') return 'stopped'
  if (job.status === 'failed') return 'failed'
  if (job.status === 'done') return 'ready-to-merge'
  if (live.includes('waiting for approval')) return 'needs-approval'
  if (live.includes('waiting for children') || live.includes('blocked')) return 'blocked'
  if (live.includes('planning')) return 'planning'
  if (job.status === 'running') return 'running'
  return 'queued'
}
