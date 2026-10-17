import type { BackgroundJob } from './background-agents'
import { AGENT_HANDOFF_CHARS, deriveBlackboardStatus } from './agent-orchestration'

export function formatBackgroundJobDetail(job: BackgroundJob, diff: string): string {
  const board = job.blackboard || deriveBlackboardStatus(job)
  const lines: string[] = [
    `${board.toUpperCase()} · ${job.status} · ${job.branch || 'no branch yet'}`,
    job.claim ? `claim: ${job.claim}` : '',
    job.parentId ? `parent: ${job.parentId.slice(0, 8)}` : '',
    job.childIds?.length ? `children: ${job.childIds.map((id) => id.slice(0, 8)).join(', ')}` : '',
    job.routeReason || '',
    job.liveStatus ? `status: ${job.liveStatus}` : '',
    job.toolsModel || job.model
      ? `model: ${(job.toolsModel || job.model || '').replace(/^builtin:/, '')}${
          job.chatModel && job.toolsModel && job.chatModel !== job.toolsModel
            ? ` (chat ${job.chatModel.replace(/^builtin:/, '')})`
            : ''
        }`
      : '',
    job.escalateCount || job.rerouteCount
      ? `adapt: escalate×${job.escalateCount || 0} reroute×${job.rerouteCount || 0}`
      : '',
    job.error ? `error: ${job.error}` : '',
    ''
  ]

  const history = job.routeHistory || []
  if (history.length) {
    lines.push('Route history')
    for (const step of history.slice(-8)) {
      lines.push(
        `  [${step.kind}] ${step.agentName || step.agentId} · ${step.model.replace(/^builtin:/, '')} — ${step.reason.slice(0, 100)}`
      )
    }
    lines.push('')
  }

  if (job.handoff) {
    lines.push('Handoff')
    lines.push(`  ${job.handoff.fromAgentId} → ${job.handoff.toAgentId}`)
    lines.push(`  ${job.handoff.summary.slice(0, AGENT_HANDOFF_CHARS)}`)
    if (job.handoff.files?.length) lines.push(`  files: ${job.handoff.files.join(', ')}`)
    lines.push('')
  }

  const tools = job.recentTools || []
  if (tools.length) {
    lines.push('Tools')
    for (const t of tools.slice(-16)) {
      const mark = t.status === 'ok' ? '✓' : t.status === 'error' ? '✗' : '…'
      lines.push(`  ${mark} ${t.name}${t.path ? ` ${t.path}` : ''}`)
      if (t.status === 'error' && t.detail) lines.push(`      ${t.detail.slice(0, AGENT_HANDOFF_CHARS)}`)
    }
    lines.push('')
  }

  if (job.thinkingTail?.trim()) {
    lines.push('Thinking (tail)')
    lines.push(job.thinkingTail.trim().slice(-AGENT_HANDOFF_CHARS))
    lines.push('')
  }

  if (job.answer?.trim()) {
    lines.push('Answer')
    lines.push(job.answer.trim().slice(0, AGENT_HANDOFF_CHARS))
    lines.push('')
  }

  if (job.hasArtifacts || (job.artifactCount && job.artifactCount > 0)) {
    lines.push(
      `Artifacts: ${job.artifactCount || job.filesTouched.length} file(s) — use Apply changes to open Diff Review`
    )
    if (job.filesTouched?.length) {
      lines.push(job.filesTouched.slice(0, 40).map((f) => `  - ${f}`).join('\n'))
    }
    lines.push('')
  }

  if (diff.trim()) {
    lines.push('Diff')
    lines.push(diff.slice(0, 12000))
  } else if (job.status === 'running' || job.status === 'queued') {
    lines.push('(diff available when the job finishes)')
  } else if (job.id.startsWith('cloud:') && !job.hasArtifacts) {
    lines.push('(no file artifacts — answer-only job, or still packing)')
  }

  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n')
}
