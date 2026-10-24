import type { AppSettings } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import { truncateForModel } from './prompts'
import { collectModelText } from './stream'
import type { AgentChatMessage } from './types'

/** Keep this many non-system messages verbatim after compaction. */
const COMPACT_TAIL_MESSAGES = 5
/** Keep older tool-result messages small before paying for model summarization. */
const MICRO_COMPACT_MAX_CHARS = 1_800

/** Deterministic fallback summary from tools that actually ran. */
export function buildWorkSummary(goal: string, actions: string[], workerNote: string): string {
  const uniqueActions = [...new Set(actions)].slice(-40)
  const goalLine = goal.replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines: string[] = []
  if (goalLine) lines.push(`Task: ${goalLine}`)
  if (uniqueActions.length > 0) {
    lines.push('')
    lines.push('What I did:')
    for (const a of uniqueActions) lines.push(`• ${a}`)
  } else if (workerNote.trim()) {
    lines.push('')
    lines.push(workerNote.trim().slice(0, AGENT_HANDOFF_CHARS))
  } else {
    lines.push('Done.')
  }
  return lines.join('\n')
}

/** Rough token estimate for local budgeting (chars/4). */
function estimateTokens(messages: AgentChatMessage[]): number {
  let chars = 0
  for (const m of messages)
    chars += m.content.length + JSON.stringify(m.tool_calls ?? []).length + 8
  return Math.ceil(chars / 3)
}

/**
 * Zero-model-cost compaction for old tool dumps. The system prompt is pinned
 * and recent turns are preserved unless older trims do not restore the budget.
 * Returns early once the prompt is back under budget.
 */
export function microCompactAgentMessages(
  messages: AgentChatMessage[],
  budgetTokens: number
): { messages: AgentChatMessage[]; changed: boolean; withinBudget: boolean } {
  if (estimateTokens(messages) <= budgetTokens) {
    return { messages, changed: false, withinBudget: true }
  }

  const nonSystemIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system')
    .map(({ index }) => index)
  const protectedFrom =
    nonSystemIndexes[Math.max(0, nonSystemIndexes.length - COMPACT_TAIL_MESSAGES)] ?? 0
  const compacted = messages.map((message) => ({ ...message }))
  let changed = false

  for (const index of nonSystemIndexes) {
    if (estimateTokens(compacted) <= budgetTokens) break
    const message = compacted[index]!
    const targetChars =
      index >= protectedFrom ? MICRO_COMPACT_MAX_CHARS * 2 : MICRO_COMPACT_MAX_CHARS
    if (
      (message.role !== 'tool' && !message.content.includes('TOOL_RESULT')) ||
      message.content.length <= targetChars
    )
      continue
    const marker =
      `[Earlier tool output shortened by local context cleanup. Treat omitted details as unknown; ` +
      `inspect again if needed, and do not repeat mutations just to recover this output.]`
    const retainedChars = Math.max(600, targetChars - marker.length - 4)
    const headChars = Math.floor(retainedChars * 0.68)
    const tailChars = retainedChars - headChars
    message.content =
      `${message.content.slice(0, headChars)}\n\n` +
      `${marker}\n\n` +
      message.content.slice(-tailChars)
    changed = true
  }

  return {
    messages: compacted,
    changed,
    withinBudget: estimateTokens(compacted) <= budgetTokens
  }
}

export { contextBudgetTokens } from './context-budget'

/** Runtime instructions kept after the canonical system prompt. */
const RUNTIME_INSTRUCTIONS_KEPT = 2

/**
 * Recovery and nudge messages are system messages, and budgeting pins every system
 * message, so repeated recovery can fill the context that tool-output cleanup frees.
 * Keep the leading task/authority prompt plus only the latest runtime instructions;
 * older nudges describe states the run has already left. Mutates in place.
 */
export function boundRuntimeInstructions(
  messages: AgentChatMessage[],
  keep = RUNTIME_INSTRUCTIONS_KEPT
): boolean {
  const runtime = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => index > 0 && message.role === 'system')
  const drop = new Set(
    runtime.slice(0, Math.max(0, runtime.length - keep)).map(({ index }) => index)
  )
  if (!drop.size) return false
  const kept = messages.filter((_, index) => !drop.has(index))
  messages.splice(0, messages.length, ...kept)
  return true
}

export function needsContextCompaction(
  messages: AgentChatMessage[],
  budgetTokens: number,
  force: boolean
): boolean {
  if (force) return messages.length > 4
  return estimateTokens(messages) > budgetTokens
}

export function formatActionLogForResume(actionLog: string[], limit = 40): string {
  if (actionLog.length === 0) return '(none yet)'
  const unique = [...new Set(actionLog)]
  const slice = unique.slice(-limit)
  const omitted = unique.length - slice.length
  return (omitted > 0 ? `(…${omitted} earlier)\n` : '') + slice.map((a) => `• ${a}`).join('\n')
}

const EXECUTION_CLAIM = /\b(?:installed|ran|executed|deployed|committed|pushed|migrated)\b/i
const CLAIM_STOPWORDS = new Set([
  'installed',
  'executed',
  'deployed',
  'committed',
  'pushed',
  'migrated',
  'the',
  'and',
  'with',
  'from',
  'into',
  'that',
  'this',
  'package',
  'command',
  'successfully'
])

/**
 * Generated memory can turn a suggestion into an asserted action (“installed
 * next-feature-flag” when no command ran). Execution claims must name something a
 * successful action-log entry also names; otherwise they are marked unverified.
 */
export function markUnverifiedExecutionClaims(summary: string, actionLog: string[]): string {
  const executed = actionLog
    .filter((entry) => !/^Failed\b/.test(entry))
    .join('\n')
    .toLowerCase()
  return summary
    .split('\n')
    .map((line) => {
      if (!EXECUTION_CLAIM.test(line) || /\bunverified\b|\bnot done\b|\bproposed\b/i.test(line))
        return line
      const objects = line
        .slice(line.search(EXECUTION_CLAIM))
        .toLowerCase()
        .split(/[^a-z0-9@/._-]+/)
        .filter((token) => token.length >= 4 && !CLAIM_STOPWORDS.has(token))
      const verified = objects.some((token) => executed.includes(token))
      return verified ? line : `${line} [unverified: no matching executed action]`
    })
    .join('\n')
}

function buildFallbackProgressSummary(
  goal: string,
  filesTouched: string[],
  actionLog: string[],
  priorMemory: string | null
): string {
  const parts: string[] = []
  if (priorMemory?.trim()) parts.push(priorMemory.trim().slice(0, AGENT_HANDOFF_CHARS))
  parts.push(`Goal: ${goal.slice(0, AGENT_HANDOFF_CHARS)}`)
  if (filesTouched.length) {
    parts.push(`Files touched: ${[...new Set(filesTouched)].slice(-20).join(', ')}`)
  }
  const actions = [...new Set(actionLog)].slice(-24)
  if (actions.length) parts.push(`Recent actions:\n${actions.map((a) => `• ${a}`).join('\n')}`)
  return parts.join('\n\n').slice(0, AGENT_HANDOFF_CHARS * 3)
}

function buildResumeMessage(options: {
  goal: string
  filesTouched: string[]
  actionLog: string[]
  treeSnapshot: string | null
  progressSummary: string
}): AgentChatMessage {
  const files =
    options.filesTouched.length > 0
      ? `Files already written/updated: ${[...new Set(options.filesTouched)].slice(-20).join(', ')}`
      : 'No files written yet.'
  const treeBit = options.treeSnapshot
    ? `\nWorkspace tree:\n${truncateForModel(options.treeSnapshot, AGENT_HANDOFF_CHARS)}\n`
    : ''
  return {
    role: 'user',
    content:
      `Original request:\n${options.goal.slice(0, AGENT_HANDOFF_CHARS)}\n\n` +
      `Progress summary (fallible execution memory; the task contract remains authoritative):\n` +
      `${options.progressSummary.slice(0, AGENT_HANDOFF_CHARS * 3)}\n\n` +
      `Action log (the only record of executed actions; a summary claim missing here did not happen):\n${formatActionLogForResume(options.actionLog)}\n\n` +
      `${files}${treeBit}\n` +
      `Continue until the request is fully satisfied. ` +
      `Do not redo completed actions unless fixing a failure. ` +
      `Emit write_file/mkdir/read_file tool JSON now, OR if everything is done reply with a short DONE summary and no tools.`
  }
}

async function summarizeMiddleWithLite(options: {
  settings: AppSettings
  liteModel: string
  goal: string
  middle: AgentChatMessage[]
  filesTouched: string[]
  actionLog: string[]
  priorMemory: string | null
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  temperature: number
}): Promise<string> {
  const transcript = options.middle
    .map((m) => `${m.role.toUpperCase()}:\n${m.content.slice(0, AGENT_HANDOFF_CHARS)}`)
    .join('\n\n')
    .slice(0, AGENT_HANDOFF_CHARS * 3)

  if (!transcript.trim()) {
    return buildFallbackProgressSummary(
      options.goal,
      options.filesTouched,
      options.actionLog,
      options.priorMemory
    )
  }

  const messages: AgentChatMessage[] = [
    {
      role: 'system',
      content:
        'You compress agent working memory for an Eris coding worker that will continue the same task.\n' +
        'Write a dense progress brief (max ~20 short bullets or 250 words) the next model turn can trust.\n' +
        'Include: goal restated in one line; key findings; failures/blockers; exact next actions remaining.\n' +
        'Executed actions and changed files come only from the Action log and Files touched lists. ' +
        'Never state that a command ran, a package was installed or a file changed unless it is listed there; ' +
        'anything the transcript only proposed or suggested is "proposed, not done".\n' +
        'Be concrete (paths, commands, error phrases). Drop chatter and repeated tool dumps.\n' +
        'No tools. No CALL_FULL. No markdown fences. Plain text only.'
    },
    {
      role: 'user',
      content:
        `Original request:\n${options.goal.slice(0, AGENT_HANDOFF_CHARS)}\n\n` +
        (options.priorMemory
          ? `Previous memory (fold into the new brief; do not discard open work):\n${options.priorMemory.slice(0, AGENT_HANDOFF_CHARS)}\n\n`
          : '') +
        `Files touched: ${
          options.filesTouched.length
            ? [...new Set(options.filesTouched)].slice(-20).join(', ')
            : '(none)'
        }\n\n` +
        `Action log:\n${formatActionLogForResume(options.actionLog, 30)}\n\n` +
        `Transcript to compress:\n${transcript}\n\n` +
        `Reply with only the progress brief.`
    }
  ]

  try {
    const summary = await collectModelText({
      settings: options.settings,
      model: options.liteModel,
      messages,
      temperature: Math.min(options.temperature, 0.3),
      signal: options.signal,
      getSecret: options.getSecret,
      purpose: 'compaction'
    })
    if (summary.length >= 40)
      return markUnverifiedExecutionClaims(summary, options.actionLog).slice(0, AGENT_HANDOFF_CHARS)
  } catch {
    // fall through
  }
  return buildFallbackProgressSummary(
    options.goal,
    options.filesTouched,
    options.actionLog,
    options.priorMemory
  )
}

/**
 * Compact worker context: pin system + rich resume (goal, action log, Lite summary) + recent tail.
 * Returns the new message list and rolling memory string.
 */
export async function compactAgentMessages(options: {
  messages: AgentChatMessage[]
  goal: string
  filesTouched: string[]
  actionLog: string[]
  treeSnapshot: string | null
  priorMemory: string | null
  settings: AppSettings
  liteModel: string
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** When true, skip Lite and use action-log fallback only (stuck-loop recovery). */
  skipLiteSummary?: boolean
}): Promise<{ messages: AgentChatMessage[]; memory: string }> {
  const system = options.messages.find((m) => m.role === 'system')
  const nonSystem = options.messages.filter((m) => m.role !== 'system')
  if (nonSystem.length <= COMPACT_TAIL_MESSAGES + 1) {
    return { messages: options.messages, memory: options.priorMemory ?? '' }
  }

  let split = Math.max(0, nonSystem.length - COMPACT_TAIL_MESSAGES)
  // Move the boundary before the assistant call so every retained result has its call.
  while (split > 0 && nonSystem[split]?.role === 'tool') split--
  const tail = nonSystem.slice(split)
  const middle = nonSystem.slice(0, split)

  let progressSummary: string
  if (options.skipLiteSummary) {
    progressSummary = buildFallbackProgressSummary(
      options.goal,
      options.filesTouched,
      options.actionLog,
      options.priorMemory
    )
  } else {
    progressSummary = await summarizeMiddleWithLite({
      settings: options.settings,
      liteModel: options.liteModel,
      goal: options.goal,
      middle,
      filesTouched: options.filesTouched,
      actionLog: options.actionLog,
      priorMemory: options.priorMemory,
      signal: options.signal,
      getSecret: options.getSecret,
      temperature: options.temperature
    })
  }

  const resume = buildResumeMessage({
    goal: options.goal,
    filesTouched: options.filesTouched,
    actionLog: options.actionLog,
    treeSnapshot: options.treeSnapshot,
    progressSummary
  })

  const out: AgentChatMessage[] = []
  if (system) out.push(system)
  out.push(resume)
  out.push(...tail)
  return { messages: out, memory: progressSummary }
}
