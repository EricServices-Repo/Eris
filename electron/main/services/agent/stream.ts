import type { AppSettings } from '../../../../src/shared/settings-schema'
import { isNativeGgufRef } from '../builtin-model'
import { reasoningShown, streamModelChat, type OpenAIToolDef } from '../chat-runtime'
import type { ModelPurpose } from '../model-transport'
import { splitLeadingReasoning } from '../reasoning-split'
import { toolProtocolFor } from '../tool-protocol'
import { looksLikeDegenerateLoop } from './heuristics'
import {
  hasExecutableToolCall,
  nativeToToolCalls,
  stripToolBlocks,
  thinkingBeforeTools
} from './tool-parsing'
import type { AgentChatMessage, ToolCall } from './types'

/** Collect a one-shot model reply without streaming to the UI. */
export async function collectModelText(options: {
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  purpose?: ModelPurpose
}): Promise<string> {
  let full = ''
  for await (const evt of streamThinkingText({
    ...options,
    stopOnToolCall: false
  })) {
    if (evt.kind === 'done') full = stripToolBlocks(evt.full)
  }
  return stripToolBlocks(full).trim()
}

/** Stream model output, yielding thinking tokens as they arrive (or sliced if batched). */
export async function* streamThinkingText(options: {
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
  /** Stop generation as soon as a complete tool call is parsed (IDE agent turns). */
  stopOnToolCall?: boolean
  /** OpenAI-compatible native tools (skipped for builtin GGUF). */
  tools?: OpenAIToolDef[]
  /** Constrain builtin GGUF decoding to a tool-call JSON schema (retry nudges). */
  builtinJsonSchema?: Record<string, unknown>
  /** Reuse local GGUF KV across steps (native GGUF only). */
  sessionKey?: string
  /** Pipeline stage for transport accounting; defaults to agent. */
  purpose?: ModelPurpose
}): AsyncGenerator<
  | { kind: 'thinking'; text: string }
  /** The model's own reasoning, separate from its reply (#573). */
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'done'
      full: string
      aborted?: 'loop' | 'tool' | 'user'
      nativeToolCalls?: ToolCall[]
    },
  void,
  unknown
> {
  let full = ''
  let shown = 0
  let nativeToolCalls: ToolCall[] | undefined
  let finished = false
  let sawReasoning = false
  const localAbort = new AbortController()
  const onParentAbort = () => localAbort.abort()
  options.signal?.addEventListener('abort', onParentAbort)
  if (options.signal?.aborted) localAbort.abort()

  const rethrowIfUserStop = (): void => {
    if (options.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  /** Cheap gate — full parseToolCalls is expensive on every token. */
  const chunkMayContainTool = (chunk: string): boolean =>
    chunk.includes('{') ||
    chunk.includes('<<<') ||
    chunk.includes('<tool') ||
    chunk.includes('</tool')

  const useNativeTools =
    Boolean(options.tools?.length) &&
    options.stopOnToolCall &&
    toolProtocolFor(options.settings, options.model) === 'native-tools'

  try {
    rethrowIfUserStop()
    for await (const item of interleaveReasoning((onReasoning) => streamModelChat({
      onReasoning,
      settings: options.settings,
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      signal: localAbort.signal,
      getSecret: options.getSecret,
      purpose: options.purpose ?? 'agent',
      builtinJsonSchema: options.builtinJsonSchema,
      sessionKey: isNativeGgufRef(options.model) ? options.sessionKey : undefined,
      tools: options.stopOnToolCall ? options.tools : undefined,
      toolChoice: useNativeTools ? 'auto' : undefined,
      onNativeToolCalls: useNativeTools
        ? (calls) => {
            nativeToolCalls = nativeToToolCalls(calls)
          }
        : undefined
    }))) {
      rethrowIfUserStop()
      // Reasoning is shown, never parsed: it stays out of `full` (#573).
      if (item.kind === 'reasoning') {
        sawReasoning = true
        yield { kind: 'reasoning', text: item.text }
        continue
      }
      const chunk = item.text
      full += chunk
      const visible = thinkingBeforeTools(full)
      if (visible.length > shown) {
        yield { kind: 'thinking', text: visible.slice(shown) }
        shown = visible.length
      }

      if (looksLikeDegenerateLoop(full)) {
        localAbort.abort()
        yield {
          kind: 'thinking',
          text: '\n\n— Stopped a repetitive loop in the model output.\n'
        }
        yield { kind: 'done', full, aborted: 'loop', nativeToolCalls }
        return
      }

      // Execute as soon as we have a complete tool JSON — don't wait for maxTokens
      // (text protocol only; native tool_calls arrive at stream end)
      if (
        !useNativeTools &&
        options.stopOnToolCall &&
        chunkMayContainTool(chunk) &&
        hasExecutableToolCall(full)
      ) {
        localAbort.abort()
        yield {
          kind: 'thinking',
          text: '\n\n— Tool call received; running it…\n'
        }
        yield { kind: 'done', full, aborted: 'tool', nativeToolCalls }
        return
      }
    }
    finished = true
    rethrowIfUserStop()
    if (nativeToolCalls?.length) {
      yield {
        kind: 'thinking',
        text: '\n\n— Tool call received; running it…\n'
      }
      yield { kind: 'done', full, aborted: 'tool', nativeToolCalls }
      return
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const msg = err instanceof Error ? err.message : String(err)
    const isAbort = name === 'AbortError' || localAbort.signal.aborted || /abort/i.test(msg)

    // User clicked Stop — unwind the whole agent run (do not continue tools).
    if (options.signal?.aborted) {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      throw e
    }

    // Local abort only (early tool stop / stream cancel) — hand partial text back.
    if (isAbort) {
      const reason: 'tool' | undefined =
        options.stopOnToolCall && (Boolean(nativeToolCalls?.length) || hasExecutableToolCall(full))
          ? 'tool'
          : undefined
      yield { kind: 'done', full, aborted: reason, nativeToolCalls }
      return
    }
    throw err
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort)
    // A consumer that stops iterating early must not leave the model generating.
    if (!finished) localAbort.abort()
  }

  // A block opened in the prompt ends with a bare closing tag; only the whole reply
  // shows it (see reasoning-split.ts).
  // A transport that separated reasoning itself never also writes it inline.
  const leading = sawReasoning ? null : splitLeadingReasoning(full)
  if (leading) {
    if (leading.reasoning && reasoningShown(options.settings, options.model))
      yield { kind: 'reasoning', text: leading.reasoning }
    full = leading.answer
  }
  yield { kind: 'done', full, nativeToolCalls }
}

/**
 * Merge a text stream and the reasoning reported beside it into one ordered stream.
 * Reasoning arrives through a callback, often while no text is flowing (a model
 * reasons before it answers), so it cannot wait for the next text chunk. Text is
 * still pulled one chunk at a time, so the model stream keeps its backpressure.
 */
export async function* interleaveReasoning(
  start: (onReasoning: (text: string) => void) => AsyncGenerator<string, void, unknown>
): AsyncGenerator<{ kind: 'text' | 'reasoning'; text: string }, void, unknown> {
  const reasoning: string[] = []
  let wake: (() => void) | null = null
  const stream = start((text) => {
    if (!text) return
    reasoning.push(text)
    wake?.()
  })
  let next: Promise<IteratorResult<string, void>> | null = null
  let ended = false
  try {
    while (true) {
      while (reasoning.length) yield { kind: 'reasoning', text: reasoning.shift()! }
      next ??= stream.next()
      const arrived = new Promise<null>((resolve) => (wake = () => resolve(null)))
      // The generator may report reasoning synchronously from inside next().
      if (reasoning.length) wake!()
      const result = await Promise.race([next, arrived])
      wake = null
      if (result === null) continue
      next = null
      if (result.done) break
      yield { kind: 'text', text: result.value }
    }
    ended = true
    while (reasoning.length) yield { kind: 'reasoning', text: reasoning.shift()! }
  } finally {
    if (!ended) {
      // Do not wait for a pull that is still running: the caller aborts the model,
      // which ends it. Waiting here would hold the caller's own cleanup back.
      next?.catch(() => undefined)
      void stream.return(undefined).catch(() => undefined)
    }
  }
}
