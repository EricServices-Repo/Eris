import type { AppSettings } from '../../../../src/shared/settings-schema'
import { isBuiltinRef } from '../builtin-model'
import { streamModelChat, type OpenAIToolDef } from '../chat-runtime'
import { looksLikeDegenerateLoop } from './heuristics'
import { hasExecutableToolCall, nativeToToolCalls, stripToolBlocks } from './tool-parsing'
import type { AgentChatMessage, ToolCall } from './types'

/** Collect a one-shot model reply without streaming to the UI. */
export async function collectModelText(options: {
  settings: AppSettings
  model: string
  messages: AgentChatMessage[]
  temperature: number
  signal?: AbortSignal
  getSecret: (key: string) => string | null
}): Promise<string> {
  let full = ''
  for await (const evt of streamThinkingText({
    ...options,
    stopOnToolCall: false
  })) {
    if (evt.kind === 'done') full = evt.full
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
}): AsyncGenerator<
  | { kind: 'thinking'; text: string }
  | {
      kind: 'done'
      full: string
      aborted?: 'loop' | 'tool' | 'user'
      nativeToolCalls?: ToolCall[]
    }
  ,
  void,
  unknown
> {
  let full = ''
  let nativeToolCalls: ToolCall[] | undefined
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
    !isBuiltinRef(options.model)

  try {
    rethrowIfUserStop()
    for await (const chunk of streamModelChat({
      settings: options.settings,
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      signal: localAbort.signal,
      getSecret: options.getSecret,
      tools: useNativeTools ? options.tools : undefined,
      toolChoice: useNativeTools ? 'auto' : undefined,
      onNativeToolCalls: useNativeTools
        ? (calls) => {
            nativeToolCalls = nativeToToolCalls(calls)
          }
        : undefined
    })) {
      rethrowIfUserStop()
      full += chunk
      // Emit whole provider chunks — IPC coalescing happens in main (index.ts).
      yield { kind: 'thinking', text: chunk }

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
    const isAbort =
      name === 'AbortError' ||
      localAbort.signal.aborted ||
      /abort/i.test(msg)

    // User clicked Stop — unwind the whole agent run (do not continue tools).
    if (options.signal?.aborted) {
      const e = new Error('Aborted')
      e.name = 'AbortError'
      throw e
    }

    // Local abort only (early tool stop / stream cancel) — hand partial text back.
    if (isAbort) {
      const reason: 'tool' | undefined =
        options.stopOnToolCall &&
        (Boolean(nativeToolCalls?.length) || hasExecutableToolCall(full))
          ? 'tool'
          : undefined
      yield { kind: 'done', full, aborted: reason, nativeToolCalls }
      return
    }
    throw err
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort)
  }

  yield { kind: 'done', full, nativeToolCalls }
}
