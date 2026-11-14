/**
 * Separates a model's inline reasoning from its answer (#573).
 *
 * Some backends deliver reasoning in its own field (OpenAI-compatible
 * `reasoning_content`, Ollama `message.thinking`, node-llama-cpp thought segments).
 * Others, when the server has no reasoning parser or the chat template is not
 * recognised, write it into the normal text as `<think>…</think>`. This module turns
 * that inline form into the same separate stream.
 *
 * Streaming rules (createReasoningSplitter):
 * - Only a tag at the start of the output (after optional whitespace) opens reasoning.
 *   A `<think>` later in an answer, for example in a code sample, is answer text.
 * - Tags may be split across chunks. Before the start is decided, at most one opening
 *   tag's length is held; inside reasoning, at most one closing tag's length.
 * - An unclosed block at the end of the stream is all reasoning.
 *
 * Some templates open the block in the prompt, so the model emits only `…</think>`.
 * Streaming cannot tell that apart from an answer without holding every answer back,
 * so that form is handled on the complete text by splitLeadingReasoning.
 */

export type ReasoningSplit = { answer: string; reasoning: string }

export type ReasoningSplitter = {
  push(chunk: string): ReasoningSplit
  flush(): ReasoningSplit
}

export const REASONING_TAGS: ReadonlyArray<readonly [string, string]> = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>']
]

const NONE: ReasoningSplit = { answer: '', reasoning: '' }

export function createReasoningSplitter(
  tags: ReadonlyArray<readonly [string, string]> = REASONING_TAGS
): ReasoningSplitter {
  let state: 'start' | 'reasoning' | 'answer' = 'start'
  let held = ''
  let close = ''

  const decideStart = (final: boolean): ReasoningSplit => {
    const lead = held.trimStart()
    if (!lead) return final ? release() : NONE
    for (const [open, end] of tags) {
      if (lead.startsWith(open)) {
        state = 'reasoning'
        close = end
        held = lead.slice(open.length)
        return inside(final)
      }
    }
    // Could still become an opening tag once more text arrives.
    if (!final && tags.some(([open]) => open.startsWith(lead))) return NONE
    return release()
  }

  const release = (): ReasoningSplit => {
    state = 'answer'
    const answer = held
    held = ''
    return { answer, reasoning: '' }
  }

  const inside = (final: boolean): ReasoningSplit => {
    const at = held.indexOf(close)
    if (at !== -1) {
      const reasoning = held.slice(0, at)
      const answer = held.slice(at + close.length).replace(/^\s+/, '')
      state = 'answer'
      held = ''
      return { answer, reasoning }
    }
    if (final) {
      const reasoning = held
      held = ''
      return { answer: '', reasoning }
    }
    // Hold back a possible partial closing tag; release the rest.
    let cut = held.length
    for (let n = Math.min(held.length, close.length - 1); n > 0; n--) {
      if (close.startsWith(held.slice(held.length - n))) {
        cut = held.length - n
        break
      }
    }
    const reasoning = held.slice(0, cut)
    held = held.slice(cut)
    return { answer: '', reasoning }
  }

  return {
    push(chunk) {
      if (!chunk) return NONE
      if (state === 'answer') return { answer: chunk, reasoning: '' }
      held += chunk
      return state === 'start' ? decideStart(false) : inside(false)
    },
    flush() {
      if (state === 'answer') return NONE
      return state === 'start' ? decideStart(true) : inside(true)
    }
  }
}

/**
 * Split a complete text whose reasoning block was opened in the prompt: the model
 * wrote reasoning, then a bare closing tag, then the answer. A closing tag preceded by
 * an opening tag is not this form (createReasoningSplitter handles that). Returns null
 * when the text has no such block.
 */
export function splitLeadingReasoning(
  text: string,
  tags: ReadonlyArray<readonly [string, string]> = REASONING_TAGS
): ReasoningSplit | null {
  for (const [open, end] of tags) {
    const at = text.indexOf(end)
    if (at === -1) continue
    const before = text.slice(0, at)
    if (before.includes(open)) continue
    // Code before the closer means the tag is part of an answer, not a reasoning block.
    if (before.includes('```')) continue
    return { reasoning: before.trim(), answer: text.slice(at + end.length).replace(/^\s+/, '') }
  }
  return null
}

type ReasoningLevel = 'default' | 'off' | 'low' | 'medium' | 'high'

/** node-llama-cpp thought-token budgets per requested level; `default` keeps the library's. */
const THOUGHT_BUDGET: Record<Exclude<ReasoningLevel, 'default'>, number> = {
  off: 0,
  low: 1024,
  medium: 4096,
  high: 16384
}

/**
 * node-llama-cpp prompt options that stream thought segments on their own channel.
 * onTextChunk already excludes them; without this they were generated and discarded.
 */
export function thoughtSegmentOptions(
  level: ReasoningLevel | undefined,
  maxTokens: number,
  onReasoning: ((text: string) => void) | undefined
): Record<string, unknown> {
  const budget = level && level !== 'default' ? THOUGHT_BUDGET[level] : undefined
  return {
    ...(onReasoning
      ? {
          onResponseChunk(chunk: { type?: string; segmentType?: string; text?: string }) {
            if (chunk.type === 'segment' && chunk.segmentType === 'thought' && chunk.text)
              onReasoning(chunk.text)
          }
        }
      : {}),
    ...(budget === undefined ? {} : { budgets: { thoughtTokens: Math.min(budget, maxTokens) } })
  }
}
