import { assertTaskReferences } from '../reference-binding'
import type { AppSettings } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import { truncateForModel } from './prompts'
import { collectModelText } from './stream'
import type { AgentChatMessage } from './types'
import { contextUnits } from '../../../../src/shared/token-estimate'
import { EVICTION_STUB_PREFIX } from './run-journal'

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
export function estimateTokens(messages: AgentChatMessage[]): number {
  let chars = 0
  for (const m of messages)
    chars += contextUnits(m.content) + JSON.stringify(m.tool_calls ?? []).length + 8
  return Math.ceil(chars / 3)
}

/** Where evicted output stays. Absent when this destination cannot read it back. */
export type EvidenceStore = {
  evictionStub(toolCallId: string, shown: string): string | undefined
  evidenceIndex(exceptCalls: ReadonlySet<string>, maxChars: number): string
}

const callIdOf = (message: AgentChatMessage) => (message as { tool_call_id?: string }).tool_call_id

const evidenceStub = (message: AgentChatMessage, evidence: EvidenceStore | undefined) => {
  const id = callIdOf(message)
  return id ? evidence?.evictionStub(id, message.content) : undefined
}

/**
 * Zero-model-cost compaction for old tool dumps. The system prompt is pinned
 * and recent turns are preserved unless older trims do not restore the budget.
 * Returns early once the prompt is back under budget.
 *
 * With an evidence store, output is replaced by a handle to the original. Older
 * output is evicted newest first, because a change late in the prompt leaves the
 * longest prefix for KV to reuse. A result with no readable original keeps the
 * head-and-tail excerpt.
 */
export function microCompactAgentMessages(
  messages: AgentChatMessage[],
  budgetTokens: number,
  evidence?: EvidenceStore
): {
  messages: AgentChatMessage[]
  changed: boolean
  withinBudget: boolean
  evicted: number
  shortened: number
} {
  if (estimateTokens(messages) <= budgetTokens) {
    return { messages, changed: false, withinBudget: true, evicted: 0, shortened: 0 }
  }

  const nonSystemIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system')
    .map(({ index }) => index)
  const protectedFrom =
    nonSystemIndexes[Math.max(0, nonSystemIndexes.length - COMPACT_TAIL_MESSAGES)] ?? 0
  const compacted = messages.map((message) => ({ ...message }))
  let evicted = 0
  let shortened = 0
  const order = evidence
    ? [
        ...nonSystemIndexes.filter((index) => index < protectedFrom).reverse(),
        ...nonSystemIndexes.filter((index) => index >= protectedFrom)
      ]
    : nonSystemIndexes

  for (const index of order) {
    if (estimateTokens(compacted) <= budgetTokens) break
    const message = compacted[index]!
    if (message.content.startsWith(EVICTION_STUB_PREFIX)) continue
    const stub = evidenceStub(message, evidence)
    if (stub) {
      if (message.content.length <= stub.length) continue
      message.content = stub
      evicted++
      continue
    }
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
    shortened++
  }

  return {
    messages: compacted,
    changed: evicted + shortened > 0,
    withinBudget: estimateTokens(compacted) <= budgetTokens,
    evicted,
    shortened
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
  evidenceIndex?: string
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
      (options.evidenceIndex
        ? `Earlier tool output, held in full (context_read with a ref; do not rerun a tool to recover it):\n${options.evidenceIndex}\n\n`
        : '') +
      `${files}${treeBit}\n` +
      `Continue until the request is fully satisfied. ` +
      `Do not redo completed actions unless fixing a failure. ` +
      `Emit write_file/mkdir/read_file tool JSON now, OR if everything is done reply with a short DONE summary and no tools.`
  }
}

/** Smallest share worth sending; below this a message is omitted, oldest first. */
const SUMMARY_MIN_MESSAGE_CHARS = 240
/** The newest message weighs this much relative to the oldest. */
const SUMMARY_NEWEST_WEIGHT = 2

function excerptForSummary(content: string, chars: number): string {
  if (content.length <= chars) return content
  const marker = '\n[shortened for this summary]\n'
  const keep = Math.max(0, chars - marker.length)
  // Tool output usually ends with its result, so keep both ends.
  const head = Math.ceil(keep * 0.6)
  return content.slice(0, head) + marker + content.slice(content.length - (keep - head))
}

/**
 * Spend the summarizer's input across the whole range, weighted linearly toward newer
 * messages. Filling newest first rolls anything a short message leaves unused to older
 * ones. Reports what it could not include, because a model cannot disclose text it
 * never received.
 */
export function buildSummaryTranscript(
  messages: AgentChatMessage[],
  maxChars = AGENT_HANDOFF_CHARS * 3
): { transcript: string; omittedMessages: number; shortenedMessages: number } {
  const useful = messages.filter((message) => message.content.trim())
  // The oldest share is 1/1.5 of an even one, so this keeps every share above the minimum.
  const evenShareRatio = (1 + SUMMARY_NEWEST_WEIGHT) / 2
  const capacity = Math.max(1, Math.floor(maxChars / (SUMMARY_MIN_MESSAGE_CHARS * evenShareRatio)))
  const included = useful.slice(-capacity)
  const weight = (index: number) =>
    1 + ((SUMMARY_NEWEST_WEIGHT - 1) * index) / Math.max(1, included.length - 1)
  let unspentWeight = included.reduce((sum, _, index) => sum + weight(index), 0)
  const parts: string[] = []
  let remaining = maxChars
  let shortenedMessages = 0
  for (let index = included.length - 1; index >= 0; index--) {
    const message = included[index]!
    const label = `${message.role.toUpperCase()}:\n`
    const separator = 2
    const share = Math.floor((remaining * weight(index)) / unspentWeight)
    const chars = Math.min(AGENT_HANDOFF_CHARS, share) - label.length - separator
    const excerpt = excerptForSummary(message.content, chars)
    if (excerpt.length < message.content.length) shortenedMessages++
    parts.unshift(label + excerpt)
    remaining -= label.length + excerpt.length + separator
    unspentWeight -= weight(index)
  }
  return {
    transcript: parts.join('\n\n'),
    omittedMessages: useful.length - included.length,
    shortenedMessages
  }
}

function summaryCoverageNote(omittedMessages: number, shortenedMessages: number): string {
  if (!omittedMessages && !shortenedMessages) return ''
  const gaps = [
    omittedMessages ? `${omittedMessages} oldest compacted messages were not included` : '',
    shortenedMessages ? `${shortenedMessages} were shortened` : ''
  ].filter(Boolean)
  return `\n[Summary input was incomplete: ${gaps.join('; ')}. Treat missing details as unknown.]`
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
  citeRefs?: boolean
}): Promise<string> {
  const { transcript, omittedMessages, shortenedMessages } = buildSummaryTranscript(options.middle)

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
        (options.citeRefs
          ? 'Keep any [ref:...] handle you rely on, so the original output can be read back.\n'
          : '') +
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
    if (summary.length >= 40) {
      const note = summaryCoverageNote(omittedMessages, shortenedMessages)
      return (
        markUnverifiedExecutionClaims(summary, options.actionLog).slice(
          0,
          AGENT_HANDOFF_CHARS - note.length
        ) + note
      )
    }
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
  evidence?: EvidenceStore
  /** Also pay for a model summary when every result can be read back without one. */
  summarizeEvicted?: boolean
}): Promise<{ messages: AgentChatMessage[]; memory: string; lossless: boolean }> {
  const system = options.messages.find((m) => m.role === 'system')
  const nonSystem = options.messages.filter((m) => m.role !== 'system')
  if (nonSystem.length <= COMPACT_TAIL_MESSAGES + 1) {
    return { messages: options.messages, memory: options.priorMemory ?? '', lossless: true }
  }

  let split = Math.max(0, nonSystem.length - COMPACT_TAIL_MESSAGES)
  // Move the boundary before the assistant call so every retained result has its call.
  while (split > 0 && nonSystem[split]?.role === 'tool') split--
  const tail = nonSystem.slice(split)
  const middle = nonSystem.slice(0, split)
  const lossless = middle.every(
    (message) =>
      message.role !== 'tool' ||
      message.content.startsWith(EVICTION_STUB_PREFIX) ||
      Boolean(evidenceStub(message, options.evidence))
  )
  const tailCalls = new Set(tail.map(callIdOf).filter((id): id is string => Boolean(id)))
  const evidenceIndex = options.evidence?.evidenceIndex(tailCalls, AGENT_HANDOFF_CHARS)

  let skipLite =
    options.skipLiteSummary || (lossless && Boolean(options.evidence) && !options.summarizeEvicted)
  if (!skipLite) {
    try {
      for (const message of options.messages) {
        const referenceTask = message.contextBundle?.referenceTask
        if (referenceTask)
          await assertTaskReferences(referenceTask, options.settings, options.liteModel)
      }
    } catch {
      skipLite = true
    } // A local deterministic summary preserves privacy without another model call.
  }
  let progressSummary: string
  if (skipLite) {
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
      temperature: options.temperature,
      citeRefs: Boolean(options.evidence)
    })
  }

  const resume = buildResumeMessage({
    goal: options.goal,
    filesTouched: options.filesTouched,
    actionLog: options.actionLog,
    treeSnapshot: options.treeSnapshot,
    progressSummary,
    evidenceIndex
  })

  const out: AgentChatMessage[] = []
  if (system) out.push(system)
  out.push(resume)
  out.push(...tail)
  return { messages: out, memory: progressSummary, lossless }
}
