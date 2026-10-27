import { createHash } from 'crypto'
import { assembledSyntax } from './artifact-syntax'
import type { AppSettings } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import {
  assessDeliverable,
  stripProtocolTail,
  deliverableContext
} from '../../../../src/shared/deliverable-checks'
import { collectModelText } from './stream'
import type { AgentChatMessage } from './types'

/** Checks that mean the text is about the runtime rather than the user's task. */
const PROTOCOL_CHECKS = new Set(['protocol-leak', 'tool-call-as-answer', 'tool-schema-discussion'])

const REANSWER_SYSTEM =
  'Answer the user’s request directly in markdown. You have no tools in this reply. ' +
  'Do not mention tools, tool calls, arguments, retrieval or file listings, and do not ask the user to repair them. ' +
  'If a fact depends on project files you have not seen, state your assumption and give general guidance.'

const CONTINUE_CODE =
  'Your previous reply stopped before its code was complete. Continue exactly where it stopped, ' +
  'without repeating earlier text, and close every open code block.'

export const INCOMPLETE_CODE_NOTE =
  '\n\n_The code above stopped before it was complete; treat it as a partial draft._'

export const PROTOCOL_BLOCKER =
  'I couldn’t produce a usable answer: the model returned internal tool instructions instead of a response. ' +
  'Retry the request, or rephrase it.'

export interface FinalAnswerOptions {
  settings: AppSettings
  model: string
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  goal: string
  /** The conversation the answer was generated in, for a code continuation. */
  messages: AgentChatMessage[]
  /** Source text the worker actually read, offered again to a re-answer. */
  onPresentation?: (audit: {
    raw: string
    rawDigest: string
    presentationDigest: string
    repairs: string[]
  }) => void
  evidence?: string
}

function protocolProblems(text: string, goal: string): boolean {
  return assessDeliverable(text, deliverableContext(goal)).checks.some(
    (check) => PROTOCOL_CHECKS.has(check.id) && check.severity === 'fail'
  )
}

/**
 * Last step before an answer is shown. Internal framing is cut off or answered
 * again from the original goal once; a reply that stops mid-code gets one bounded
 * continuation. Anything still broken is returned as incomplete, never as done.
 * The worker's draft is kept as the base, so a failed repair loses nothing.
 */
export async function finalizeAnswer(
  answer: string,
  options: FinalAnswerOptions
): Promise<{ text: string; incomplete: boolean; repaired: string[]; rawOutput: string }> {
  const repaired: string[] = []
  let text = answer
  const finish = (text: string, incomplete: boolean, repaired: string[]) => {
    options.onPresentation?.({
      raw: answer,
      rawDigest: createHash('sha256').update(answer).digest('hex'),
      presentationDigest: createHash('sha256').update(text).digest('hex'),
      repairs: [...repaired]
    })
    return { text, incomplete, repaired, rawOutput: answer }
  }
  if (protocolProblems(text, options.goal)) {
    const stripped = stripProtocolTail(text)
    if (stripped && !protocolProblems(stripped, options.goal)) {
      text = stripped
      repaired.push('protocol-tail-removed')
    } else {
      const again = await collectModelText({
        settings: options.settings,
        model: options.model,
        temperature: options.temperature,
        signal: options.signal,
        getSecret: options.getSecret,
        messages: [
          { role: 'system', content: REANSWER_SYSTEM },
          {
            role: 'user',
            content:
              options.goal.slice(0, AGENT_HANDOFF_CHARS * 2) +
              (options.evidence
                ? `\n\nProject sources that were read:\n${options.evidence.slice(0, AGENT_HANDOFF_CHARS * 2)}`
                : '')
          }
        ]
      }).catch((error: unknown) => {
        if (options.signal?.aborted) throw error
        return ''
      })
      if (again.trim() && !protocolProblems(again, options.goal)) {
        text = again.trim()
        repaired.push('re-answered-from-goal')
      } else {
        return finish(PROTOCOL_BLOCKER, true, repaired)
      }
    }
  }

  if (assembledSyntax(text, options.goal).state === 'invalid')
    return finish(text + INCOMPLETE_CODE_NOTE, true, repaired)
  if (
    !assessDeliverable(text, deliverableContext(options.goal)).checks.some(
      (check) => check.id === 'unfinished-code'
    )
  )
    return finish(text, false, repaired)

  const continuation = await collectModelText({
    settings: options.settings,
    model: options.model,
    temperature: options.temperature,
    signal: options.signal,
    getSecret: options.getSecret,
    messages: [
      ...options.messages,
      { role: 'assistant', content: text },
      { role: 'system', content: CONTINUE_CODE }
    ]
  }).catch((error: unknown) => {
    if (options.signal?.aborted) throw error
    return ''
  })
  if (continuation.trim() && !protocolProblems(continuation, options.goal)) {
    const joined = `${text}${/\s$/.test(text) ? '' : '\n'}${continuation.replace(/^\n+/, '')}`
    repaired.push('code-continued')
    if (!assessDeliverable(joined).checks.some((check) => check.id === 'unfinished-code'))
      return finish(joined, false, repaired)
    text = joined
  }
  return finish(text + INCOMPLETE_CODE_NOTE, true, repaired)
}
