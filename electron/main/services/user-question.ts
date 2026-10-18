import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import { AGENT_HANDOFF_CHARS } from '../../../src/shared/agent-orchestration'

// Keep an agent paused long enough for the user to finish a thought; Stop remains available.
export const USER_QUESTION_TIMEOUT_MS = 5 * 60_000

export type UserQuestionOutcome =
  | { kind: 'reply'; text: string }
  | { kind: 'timeout' }
  | { kind: 'dismissed' }

export interface UserQuestionRequest {
  requestId: string
  questionId: string
  question: string
  choices?: string[]
  timeoutMs: number
}

const pending = new Map<
  string,
  { requestId: string; done: (outcome: UserQuestionOutcome) => void }
>()

/** Ask the renderer for a short answer; times out to proceed without a reply. */
export function requestUserQuestion(
  sender: WebContents,
  requestId: string,
  question: string,
  options?: { choices?: string[]; timeoutMs?: number; signal?: AbortSignal }
): Promise<UserQuestionOutcome> {
  const questionId = randomUUID()
  const timeoutMs = Math.max(1_000, options?.timeoutMs ?? USER_QUESTION_TIMEOUT_MS)
  const signal = options?.signal
  const choices = options?.choices?.map((c) => c.trim()).filter(Boolean).slice(0, 6)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (outcome: UserQuestionOutcome) => {
      if (settled) return
      settled = true
      pending.delete(questionId)
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!sender.isDestroyed()) {
        sender.send('chat:question-resolved', {
          requestId,
          questionId,
          timedOut: outcome.kind === 'timeout',
          dismissed: outcome.kind === 'dismissed',
          reply: outcome.kind === 'reply' ? outcome.text : undefined
        })
      }
      resolve(outcome)
    }

    const onAbort = () => finish({ kind: 'dismissed' })

    pending.set(questionId, { requestId, done: finish })

    if (signal?.aborted) {
      finish({ kind: 'dismissed' })
      return
    }
    signal?.addEventListener('abort', onAbort)

    if (sender.isDestroyed()) {
      finish({ kind: 'dismissed' })
      return
    }

    const req: UserQuestionRequest = {
      requestId,
      questionId,
      question: question.trim().slice(0, AGENT_HANDOFF_CHARS),
      choices: choices?.length ? choices : undefined,
      timeoutMs
    }
    sender.send('chat:question-request', req)
    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
  })
}

/** Resolve with a reply string, or null/empty to proceed without answering. */
export function resolveUserQuestion(questionId: string, reply: string | null): boolean {
  const entry = pending.get(questionId)
  if (!entry) return false
  const text = (reply || '').trim()
  if (text) entry.done({ kind: 'reply', text: text.slice(0, AGENT_HANDOFF_CHARS) })
  else entry.done({ kind: 'timeout' })
  return true
}

/** Cancel pending prompts — all of them, or only those raised by one chat run. */
export function cancelAllPendingQuestions(requestId?: string): void {
  for (const [id, entry] of [...pending.entries()]) {
    if (requestId === undefined || entry.requestId === requestId) {
      entry.done({ kind: 'dismissed' })
      pending.delete(id)
    }
  }
}
