import { createHash } from 'crypto'
import { asksForCreativeWriting } from '../../../../src/shared/agent-contract'
import { requestTextForIntent } from '../../../../src/shared/task-interpretation'
import { workerConversation } from './conversation'
import { assembledSyntax } from './artifact-syntax'
import type { AppSettings } from '../../../../src/shared/settings-schema'
import { AGENT_HANDOFF_CHARS } from '../../../../src/shared/agent-orchestration'
import {
  assessDeliverable,
  stripProtocolTail,
  stripToolCallFences,
  capabilityDenials,
  deliverableContext
} from '../../../../src/shared/deliverable-checks'
import { collectModelText } from './stream'
import type { AgentChatMessage } from './types'
import { evidenceRequirementFor } from '../../../../src/shared/task-contract'

/** Checks that mean the text is about the runtime rather than the user's task. */
const PROTOCOL_CHECKS = new Set(['protocol-leak', 'tool-call-as-answer', 'tool-schema-discussion'])

const REANSWER_SYSTEM =
  'Answer the user’s request directly in markdown. You have no tools in this reply. ' +
  'Do not mention tools, tool calls, arguments, retrieval or file listings, and do not ask the user to repair them. ' +
  'If a fact depends on project files you have not seen, state your assumption and give general guidance.'

/**
 * Re-answer for work that depends on the project. General guidance would turn an
 * evidence-dependent task into plausible prose, so the repair stays grounded or partial.
 */
const GROUNDED_REANSWER_SYSTEM =
  'Answer the user’s request directly in markdown. You have no tools in this reply. ' +
  'Do not mention tools, tool calls, arguments, retrieval or file listings, and do not ask the user to repair them. ' +
  'Use only the project sources below and facts already established in this conversation. ' +
  'Where they do not establish something, say it is not yet verified instead of giving general guidance as if it applied to this project.'

/** At most this many extra model calls may be spent repairing one answer. */
export const MAX_REPAIR_CALLS = 2

const CONTINUE_CODE =
  'Your previous reply stopped before its code was complete. Continue exactly where it stopped, ' +
  'without repeating earlier text, and close every open code block.'

export const INCOMPLETE_CODE_NOTE =
  '\n\n_The code above stopped before it was complete; treat it as a partial draft._'

export const TRUNCATED_NOTE =
  '\n\n_The model repeated itself and was stopped, so this reply is partial._'

export const PROTOCOL_BLOCKER =
  'I couldn’t produce a usable answer: the model returned internal tool instructions instead of a response. ' +
  'Retry the request, or rephrase it.'

export interface FinalAnswerOptions {
  settings: AppSettings
  model: string
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  task?: import('../../../../src/shared/task-contract').TaskContract
  goal: string
  /** The conversation the answer was generated in, for a code continuation. */
  messages: AgentChatMessage[]
  /** The stream was cut off, so the draft is partial however well-formed it looks. */
  truncated?: boolean
  /** Source text the worker actually read, offered again to a re-answer. */
  onPresentation?: (audit: {
    raw: string
    rawDigest: string
    presentationDigest: string
    repairs: string[]
    /** Every repair output, accepted or not, kept apart from the raw model draft. */
    attempts: RepairAttempt[]
  }) => void
  evidence?: string
  /**
   * Workspace paths this task actually changed. A repair is rewritten presentation, not
   * new work: it may not claim a change outside this list.
   */
  changedFiles?: string[]
  /**
   * The project check's state for this task's changes. Anything but 'passed' means
   * the answer may not call the change correct, verified, tested or working (#509).
   * 'no-check' is a skip because the project has no test or typecheck script.
   */
  verification?: 'passed' | 'failed' | 'skipped' | 'no-check' | 'not-run'
  /** The host appends its own verification note after the answer; do not add a second one. */
  verificationNoted?: boolean
  /** Chat mode. In Agent mode an answer may not claim Eris cannot edit or run (#505). */
  mode?: 'ask' | 'agent'
}

/** What a read-only role says instead of "I cannot run commands" (#505). */
export const ROLE_LIMIT_SENTENCE =
  'This agent role is read-only, so it did not edit files or run commands. Switch the agent to Composer (or Auto) and send the request again to do that.'

/** Replace capability-denial sentences with the role's limit, once. */
export function correctCapabilityDenial(text: string): string | null {
  const denials = capabilityDenials(text)
  if (!denials.length) return null
  let out = text
  denials.forEach((sentence, index) => {
    out = out.replace(sentence, index === 0 ? ROLE_LIMIT_SENTENCE : '')
  })
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

const UNVERIFIED_NOTE: Record<Exclude<NonNullable<FinalAnswerOptions['verification']>, 'passed'>, string> = {
  'no-check': 'Not verified: this project has no test or typecheck script.',
  skipped: 'Not verified: project checks were skipped in this run.',
  failed: 'Not verified: the project check did not pass.',
  'not-run': 'Not verified: no project check was run.'
}

/** "has been tested", "I verified…", "is working": a sentence that reports a check. */
const VERIFICATION_CLAIM =
  /\b(?:(?:has|have|was|were|been|is|are)\s+(?:now\s+)?(?:been\s+)?(?:verified|tested|confirmed|validated)|I\s+(?:have\s+)?(?:verified|tested|confirmed|validated)|(?:is|are)\s+(?:now\s+)?(?:working|functional)\b|works\s+(?:correctly|as\s+expected|properly|fine))\b/i
/** "the correct footer", "correctly", "properly": a quality judgement nobody checked. */
const QUALITY_CLAIM =
  /,?\s+and\s+(?:(?:has|have)\s+been\s+)?(?:verified|tested|confirmed|validated)\b|\s+(?:correctly|properly|successfully)\b|\b(the|a|an)\s+correct\s+/gi

/**
 * Remove claims that an unverified change is correct, verified, tested or working
 * (#509). Sentences that only report a check are dropped; quality adjectives are
 * removed from the rest. Returns null when there was nothing to remove.
 */
export function softenUnverifiedClaims(text: string): string | null {
  // Code blocks are content, not claims.
  const parts = text.split(/(```[\s\S]*?```)/)
  let changed = false
  const out = parts.map((part, index) => {
    if (index % 2 === 1) return part
    return part
      .split(/(?<=[.!?])(?=\s)|(?=\n)/)
      .map((sentence) => {
        if (VERIFICATION_CLAIM.test(sentence)) {
          changed = true
          return sentence.startsWith('\n') ? '\n' : ''
        }
        const softened = sentence.replace(QUALITY_CLAIM, (match, article?: string) =>
          article ? `${article} ` : ''
        )
        if (softened !== sentence) changed = true
        return softened
      })
      .join('')
  })
  if (!changed) return null
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export interface RepairAttempt {
  kind: 're-answer' | 'creative' | 'evasion' | 'continuation'
  accepted: boolean
  digest: string
  reason?: string
}

const MUTATION_CLAIM =
  /\b(?:i(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:now\s+|also\s+|just\s+)?(?:updated|modified|changed|edited|created|added|fixed|wrote|rewrote|patched|deleted|removed|renamed|refactored|implemented|applied)\b[^\n]*?(?=[.!?](?:\s|$)|\n|$)/gi
const PATH_TOKEN =
  /(?:[\w.-]+\/)*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html?|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|cs|swift|ya?ml|toml|sh|sql|vue|svelte|txt|xml)\b/gi

/**
 * Edits a repair claims that the task did not make. Text-level and conservative: a
 * first-person past-tense change naming no file counts only for project work
 * (`projectWork`) in which nothing changed, so "I wrote a poem" stays a valid answer.
 */
export function unbackedEditClaims(
  text: string,
  changedFiles: string[] = [],
  projectWork = true
): string[] {
  const changed = new Set(changedFiles.map((path) => path.replace(/\\/g, '/').toLowerCase()))
  const base = new Set([...changed].map((path) => path.split('/').pop()!))
  const claims: string[] = []
  for (const sentence of text.match(MUTATION_CLAIM) ?? []) {
    const paths = sentence.match(PATH_TOKEN) ?? []
    if (!paths.length) {
      if (projectWork && !changed.size) claims.push(sentence.trim())
      continue
    }
    for (const raw of paths) {
      const path = raw.replace(/^\.\//, '').toLowerCase()
      if (!changed.has(path) && !base.has(path.split('/').pop()!)) claims.push(raw)
    }
  }
  return claims
}

function protocolProblems(text: string, goal: string, task?: FinalAnswerOptions['task']): boolean {
  return assessDeliverable(
    text,
    deliverableContext(goal, task?.interpretation?.artifact, task?.interpretation?.language)
  ).checks.some((check) => PROTOCOL_CHECKS.has(check.id) && check.severity === 'fail')
}

const evades = (text: string) =>
  assessDeliverable(text).checks.some(
    (check) => check.id === 'refusal' || check.id === 'clarification-request'
  )

/** A short unexplained/IDE-scope rejection, not a refusal with an explicit safety reason. */
function unexplainedCreativeRefusal(text: string): boolean {
  const bare =
    /^(?:(?:i['’]m|i am) sorry[,!.]?\s*(?:but\s+)?|sorry[,!.]?\s*)?i (?:can['’]?t|cannot|am unable to) (?:assist|help)(?: you)?(?: with)? (?:that|this|your)(?: request)?[.!]?$/i
  const roleOnly =
    /^(?:(?:i['’]m|i am) sorry[,!.]?\s*(?:but\s+)?)?(?:as (?:an? )?(?:ai |coding |software )*(?:assistant|model)[, ]+)?i (?:can only|only) (?:help|assist|answer)[^.]{0,100}(?:coding|programming|software)[.!]?$/i
  return bare.test(text.trim()) || roleOnly.test(text.trim())
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
  const attempts: RepairAttempt[] = []
  let calls = 0
  let text = answer
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const finish = (text: string, incomplete: boolean, repaired: string[]) => {
    // A change nobody checked is reported as made, not as correct or verified (#509).
    if (options.verification && options.verification !== 'passed' && changes.length) {
      const softened = softenUnverifiedClaims(text)
      if (softened) {
        text = options.verificationNoted
          ? softened
          : `${softened}\n\n${UNVERIFIED_NOTE[options.verification]}`
        repaired = [...repaired, 'unverified-claims-softened']
      }
    }
    options.onPresentation?.({
      raw: answer,
      rawDigest: digest(answer),
      presentationDigest: digest(text),
      repairs: [...repaired],
      attempts: [...attempts]
    })
    return { text, incomplete, repaired, rawOutput: answer }
  }
  const grounded =
    Boolean(options.evidence) ||
    (options.task !== undefined &&
      evidenceRequirementFor(options.task.scope.applicability) === 'required')
  // A follow-up such as "what did you change?" may truthfully report the prior turn's edits.
  const changes = [
    ...new Set([
      ...(options.changedFiles ?? []),
      ...(options.task?.continuation?.changedFiles ?? [])
    ])
  ]
  /** Accept a repair only if it adds no change the task did not make. Records every attempt. */
  const vet = (kind: RepairAttempt['kind'], output: string, ok: boolean): boolean => {
    if (!output.trim()) {
      attempts.push({ kind, accepted: false, digest: digest(output), reason: 'empty' })
      return false
    }
    const claims = unbackedEditClaims(output, changes, grounded)
    const reason = claims.length
      ? `claims unapplied changes: ${claims.slice(0, 3).join(', ')}`.slice(0, 200)
      : ok
        ? undefined
        : 'failed checks'
    attempts.push({
      kind,
      accepted: !reason,
      digest: digest(output),
      ...(reason ? { reason } : {})
    })
    return !reason
  }
  const repairMessages = (extra = ''): AgentChatMessage[] => [
    ...options.messages.filter((message) => message.role === 'system'),
    {
      role: 'system',
      content:
        (grounded ? GROUNDED_REANSWER_SYSTEM : REANSWER_SYSTEM) +
        extra +
        (changes.length
          ? ` Changes actually applied (in this task or the turn it continues): ${changes.join(', ')}. Do not claim any other change.`
          : grounded
            ? ' No files were changed in this task; do not claim any change.'
            : '')
    },
    ...workerConversation(options.messages, options.goal),
    {
      role: 'user',
      content:
        options.goal +
        (options.evidence
          ? `\n\nProject sources that were read:\n${options.evidence.slice(0, AGENT_HANDOFF_CHARS * 2)}`
          : '')
    }
  ]
  const answerAgain = async (extra = '') => {
    if (calls >= MAX_REPAIR_CALLS) return ''
    calls++
    return collectModelText({
      settings: options.settings,
      model: options.model,
      temperature: options.temperature,
      signal: options.signal,
      getSecret: options.getSecret,
      messages: repairMessages(extra)
    }).catch((error: unknown) => {
      if (options.signal?.aborted) throw error
      return ''
    })
  }
  if (protocolProblems(text, options.goal, options.task)) {
    const stripped = stripProtocolTail(text)
    if (stripped && !protocolProblems(stripped, options.goal, options.task)) {
      text = stripped
      repaired.push('protocol-tail-removed')
    } else {
      const again = await answerAgain()
      if (vet('re-answer', again, !protocolProblems(again, options.goal, options.task))) {
        text = again.trim()
        repaired.push('re-answered-from-goal')
      } else {
        // Never show a raw tool envelope. Keep the rest of the draft, marked
        // incomplete, when removing the unexecuted call leaves a clean answer (#506).
        const withoutCalls = stripToolCallFences(text)
        if (withoutCalls && !protocolProblems(withoutCalls, options.goal, options.task))
          return finish(withoutCalls, true, [...repaired, 'tool-call-removed'])
        return finish(PROTOCOL_BLOCKER, true, repaired)
      }
    }
  }

  // "I cannot run commands" in Agent mode is false: only the role is limited (#505).
  if (options.mode === 'agent' && capabilityDenials(text).length) {
    const again = await answerAgain(
      ' Eris can edit files and run commands in Agent mode. Never say that Eris cannot edit files or run commands. ' +
        'If this role could not do what was asked, say that this role is read-only and that the user can switch to Composer.'
    )
    if (vet('re-answer', again, !capabilityDenials(again).length && !protocolProblems(again, options.goal, options.task))) {
      text = again.trim()
      repaired.push('re-answered-capability-denial')
    } else {
      text = correctCapabilityDenial(text) ?? text
      repaired.push('capability-denial-corrected')
    }
  }

  if (options.truncated) return finish(text + TRUNCATED_NOTE, true, repaired)
  const creative =
    options.task?.scope.applicability === 'generic' &&
    asksForCreativeWriting(requestTextForIntent(options.goal))
  if (creative && unexplainedCreativeRefusal(text)) {
    // One repair with conversational constraints intact; no tool/effect authority is added.
    const again = await answerAgain(
      ' Eris supports creative writing. Fulfill the requested literary format when allowed; retain all applicable safety restrictions. Do not decline merely because you are an IDE assistant.'
    )
    if (
      !vet(
        'creative',
        again,
        !unexplainedCreativeRefusal(again) && !protocolProblems(again, options.goal, options.task)
      )
    )
      return finish(text, true, repaired)
    text = again.trim()
    repaired.push('re-answered-creative-refusal')
  }

  // With sources in hand, asking the user what they meant is not an answer.
  if (options.evidence && evades(text)) {
    const again = await answerAgain()
    if (
      !vet('evasion', again, !evades(again) && !protocolProblems(again, options.goal, options.task))
    )
      return finish(text, true, repaired)
    text = again.trim()
    repaired.push('re-answered-evasion')
  }
  if (assembledSyntax(text, options.goal).state === 'invalid')
    return finish(text + INCOMPLETE_CODE_NOTE, true, repaired)
  if (
    !assessDeliverable(text, deliverableContext(options.goal)).checks.some(
      (check) => check.id === 'unfinished-code'
    )
  )
    return finish(text, false, repaired)

  if (calls >= MAX_REPAIR_CALLS) return finish(text + INCOMPLETE_CODE_NOTE, true, repaired)
  calls++
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
  if (
    vet('continuation', continuation, !protocolProblems(continuation, options.goal, options.task))
  ) {
    const joined = `${text}${/\s$/.test(text) ? '' : '\n'}${continuation.replace(/^\n+/, '')}`
    repaired.push('code-continued')
    if (!assessDeliverable(joined).checks.some((check) => check.id === 'unfinished-code'))
      return finish(joined, false, repaired)
    text = joined
  }
  return finish(text + INCOMPLETE_CODE_NOTE, true, repaired)
}
