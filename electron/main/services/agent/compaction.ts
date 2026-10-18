import type { AppSettings } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import { findBuiltinEntry, isBuiltinRef } from '../builtin-model'
import { truncateForModel } from './prompts'
import { collectModelText } from './stream'
import type { AgentChatMessage } from './types'
import { contextLimits } from '../vram-fit'

/** Keep this many non-system messages verbatim after compaction. */
const COMPACT_TAIL_MESSAGES = 5
/** Fraction of model context reserved for prompt before compacting. */
const COMPACT_BUDGET_RATIO = 0.65
/** Keep older tool-result messages small before paying for model summarization. */
const MICRO_COMPACT_MAX_CHARS = 1_800

/** Deterministic fallback summary from tools that actually ran. */
export function buildWorkSummary(goal: string, actions: string[], workerNote: string): string {
  const uniqueActions = [...new Set(actions)].slice(-40)
  const goalLine = goal.replace(/\s+/g, ' ').trim().slice(0, 160)
  const lines: string[] = []
  if (goalLine) lines.push(`Finished: ${goalLine}`)
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
  for (const m of messages) chars += m.content.length + 8
  return Math.ceil(chars / 4)
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
    if (!message.content.includes('TOOL_RESULT') || message.content.length <= targetChars) continue
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

/** Prompt budget before compaction — same window the model was loaded with. */
export function contextBudgetTokens(settings: AppSettings, workerModel: string): number {
  if (isBuiltinRef(workerModel)) {
    const entry = findBuiltinEntry(workerModel)
    const limits = contextLimits({
      tier: entry?.tier,
      role: entry?.role,
      modelContext: entry?.contextWindow,
      settingsContext: settings.models.contextWindow
    })
    return Math.floor(limits.max * COMPACT_BUDGET_RATIO)
  }
  const window = settings.models.contextWindow || 32768
  return Math.floor(Math.min(Math.max(window, 2048), 128000) * COMPACT_BUDGET_RATIO)
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
  return (
    (omitted > 0 ? `(…${omitted} earlier)\n` : '') + slice.map((a) => `• ${a}`).join('\n')
  )
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
      `Progress summary (compacted context — trust this over forgotten earlier turns):\n` +
      `${options.progressSummary.slice(0, AGENT_HANDOFF_CHARS * 3)}\n\n` +
      `Action log:\n${formatActionLogForResume(options.actionLog)}\n\n` +
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
        'Include: goal restated in one line; what was done; key findings; files changed; ' +
        'failures/blockers; exact next actions remaining.\n' +
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
      getSecret: options.getSecret
    })
    if (summary.length >= 40) return summary.slice(0, AGENT_HANDOFF_CHARS)
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

  const tail = nonSystem.slice(-COMPACT_TAIL_MESSAGES)
  const middle = nonSystem.slice(0, Math.max(0, nonSystem.length - COMPACT_TAIL_MESSAGES))

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
