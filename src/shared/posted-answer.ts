import type { ChatMessage, ChatThread } from './settings-schema'

/** Terminal snapshots reconcile by request-derived identity, never by appending twice. */
export function upsertTerminalReply(thread: ChatThread, reply: ChatMessage): ChatThread {
  const exists = thread.messages.some(message => message.id === reply.id)
  const userId = reply.id.endsWith(':assistant') ? `${reply.id.slice(0, -':assistant'.length)}:user` : null
  const at = userId ? thread.messages.findIndex(message => message.id === userId) : -1
  const messages = exists ? thread.messages.map(message => message.id === reply.id ? reply : message)
    : at >= 0 ? [...thread.messages.slice(0, at + 1), reply, ...thread.messages.slice(at + 1)]
      : [...thread.messages, reply]
  return {...thread,messages,updatedAt:Math.max(thread.updatedAt,reply.createdAt),
    messageCount:Math.max(thread.messageCount ?? 0,(thread.messageOffset ?? 0)+messages.length)}
}

/** Lift a real reply out of the thinking trace when the saved body is only a tool log. */
export function isToolLogReply(text: string): boolean {
  const body = text.trim()
  if (!body) return true
  if (/What I did:/.test(body) && /^Finished:/m.test(body)) return true
  if (/Failed read_file/i.test(body) && /Inspected /.test(body)) return true
  return false
}

export function promoteThinkingToAnswer(content: string, thinking: string): string {
  const prose = thinking
    .replace(/<<<TOOL>>>[\s\S]*?<<<END>>>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !/^(?:Route:|Plan:|—|\{|\[(?:ok|error)\])/.test(trimmed)
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const body = content.trim()
  if (prose.length >= 40 && !isToolLogReply(prose) && isToolLogReply(body)) {
    return prose
  }
  return content
}

/** Keep tool progress in Thinking. The reply itself belongs in the message. */
export function stripAnswerFromThinking(thinking: string, answer: string): string {
  const body = answer.trim()
  let trace = thinking.trim()
  if (!trace) return ''
  if (body && trace.includes(body)) trace = trace.replace(body, '')
  trace = trace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (body && line === body) return false
      if (body && body.includes(line) && line.length > 80) return false
      return true
    })
    .join('\n')
    .trim()
  return trace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:—|-|\[|Route:|Plan:)/.test(line))
    .join('\n')
    .trim()
}

/** The renderer and durable main-process history must finalize the same reply. */
export function finalizePostedAnswer(
  answer: string,
  thinkingRaw: string,
  aborted: boolean,
  hasAssets: boolean
): { content: string; thinking: string } {
  let content = promoteThinkingToAnswer(answer, thinkingRaw)
  if (!content.trim() && thinkingRaw && !aborted) content = promoteThinkingToAnswer('', thinkingRaw)
  if (!content.trim() && !aborted && !hasAssets)
    content = 'The agent ended without a response. Please retry the message or report this run.'
  const thinking = stripAnswerFromThinking(thinkingRaw, content)
  if (aborted) {
    if (content)
      content = content.endsWith('\n') ? `${content}_(stopped)_` : `${content}\n\n_(stopped)_`
    else if (thinking) content = '_(stopped)_'
  }
  return { content, thinking }
}

/**
 * Paragraphs the host appends to an assistant reply for the user: run status, not
 * something the model said. Stored replies from older builds also carry the outcome
 * verdict ("Outcome check: …") in their body. Sending any of these back to the model
 * as its own earlier words makes small models repeat them as if they were findings
 * (#502), so model history drops them. The user still sees them.
 */
const HOST_NOTE_PARAGRAPH =
  /^(?:Outcome check: (?:partial|unresolved|unsupported|supported)\b|Task result could not be saved\.|Partial response: the request failed before completion\.|Stopped\. Applied changes:|_\((?:stopped|incomplete)\)_\s*$)/

/** Reply text as the model should see it in later turns: host status notes removed. */
export function modelHistoryContent(content: string): string {
  return content
    .split(/\n{2,}/)
    .filter((paragraph) => !HOST_NOTE_PARAGRAPH.test(paragraph.trim()))
    .join('\n\n')
    .trim()
}

/** Outcome review result worth showing under a reply, or null. */
export function visibleOutcomeAssessment(
  assessment: import('./task-contract').TaskCompletionEvidence['assessment'] | undefined
): { label: string; reason?: string } | null {
  if (!assessment || assessment.status === 'supported' || assessment.status === 'not-run') return null
  // A reviewer that could not run says nothing about the answer (#500).
  if (assessment.status === 'unresolved' && REVIEWER_UNAVAILABLE.has(assessment.failure ?? ''))
    return null
  return { label: `Outcome check: ${assessment.status}`, reason: assessment.reason }
}

/**
 * Outcome-review failures that mean the reviewer did not produce a judgement. They
 * are recorded, but neither change the run's status nor appear as a finding (#500).
 * `reference-unavailable` is absent on purpose: missing evidence stays conservative.
 */
export const REVIEWER_UNAVAILABLE: ReadonlySet<string> = new Set([
  'timeout',
  'transport-error',
  'malformed-json',
  'schema-invalid',
  'response-limit'
])
