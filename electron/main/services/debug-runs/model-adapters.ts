import { createHash } from 'crypto'
import type {
  DebugModelCall,
  DebugModelPurpose,
  DebugRecordedResponse,
  DebugResponseSource,
  ScriptedModelTurn
} from '../../../../src/shared/debug-runs'
import { streamProviderChat, type NativeToolCall } from '../chat-runtime'
import type { ModelAdapter, ModelTransportRequest } from '../model-transport'

export type RecordedReply = Omit<
  Extract<DebugRecordedResponse, { kind: 'model' }>,
  'caseId' | 'kind'
>
export type ModelCallSink = (call: DebugModelCall, reply: RecordedReply) => void
export type ScriptQueues = Partial<Record<DebugModelPurpose, ScriptedModelTurn[]>>

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function fingerprint(messages: ModelTransportRequest['messages']): { hash: string; chars: number } {
  const text = messages
    .map(
      (message) => `${message.role}\n${typeof message.content === 'string' ? message.content : ''}`
    )
    .join('\n\u0000\n')
  return { hash: shortHash(text), chars: text.length }
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(abortError())
    signal?.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

/**
 * Answers each pipeline stage from its own queue of scripted (or recorded)
 * replies and never calls a provider. An exhausted queue returns an empty
 * reply and is flagged on the call record.
 */
export class ScriptedModelAdapter implements ModelAdapter {
  readonly kind = 'scripted' as const
  private readonly used = new Map<DebugModelPurpose, number>()
  private seq = 0

  constructor(
    private readonly script: ScriptQueues,
    private readonly source: Extract<DebugResponseSource, 'scripted' | 'recorded'>,
    private readonly sink: ModelCallSink
  ) {}

  async *stream(request: ModelTransportRequest): AsyncGenerator<string, void, unknown> {
    const started = Date.now()
    const purpose = request.purpose
    const index = this.used.get(purpose) ?? 0
    this.used.set(purpose, index + 1)
    const turn = this.script[purpose]?.[index]
    const seq = ++this.seq
    const prompt = fingerprint(request.messages)
    const native =
      turn?.nativeToolCalls?.length && request.onNativeToolCalls ? turn.nativeToolCalls : []
    const record = (text: string, error?: string) =>
      this.sink(
        {
          seq,
          purpose,
          model: request.model,
          source: this.source,
          promptHash: prompt.hash,
          promptChars: prompt.chars,
          responseHash: shortHash(text),
          responseChars: text.length,
          nativeToolCalls: native.length,
          durationMs: Date.now() - started,
          ...(turn ? { scriptIndex: index } : { exhausted: true }),
          ...(error ? { error } : {})
        },
        {
          seq,
          purpose,
          text,
          ...(native.length ? { nativeToolCalls: native } : {}),
          ...(error ? { error } : {}),
          ...(turn?.hang ? { hang: true } : {})
        }
      )
    if (!turn) {
      record('')
      return
    }
    if (turn.hang) {
      try {
        await untilAborted(request.signal)
      } catch (error) {
        record('', 'aborted while waiting for a scripted reply that never arrives')
        throw error
      }
    }
    if (turn.error) {
      record('', turn.error)
      throw new Error(turn.error)
    }
    // Record before yielding: the agent stream may stop at the first tool call.
    record(turn.text)
    if (native.length) request.onNativeToolCalls?.(native)
    if (turn.text) yield turn.text
  }
}

/** Calls the configured provider and records every reply's metadata and text. */
export class LiveModelAdapter implements ModelAdapter {
  readonly kind = 'live' as const
  private seq = 0

  constructor(private readonly sink: ModelCallSink) {}

  async *stream(request: ModelTransportRequest): AsyncGenerator<string, void, unknown> {
    const started = Date.now()
    const seq = ++this.seq
    const prompt = fingerprint(request.messages)
    let text = ''
    let native: NativeToolCall[] = []
    let error: string | undefined
    try {
      for await (const chunk of streamProviderChat({
        ...request,
        onNativeToolCalls: request.onNativeToolCalls
          ? (calls) => {
              native = calls
              request.onNativeToolCalls?.(calls)
            }
          : undefined
      })) {
        text += chunk
        yield chunk
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.sink(
        {
          seq,
          purpose: request.purpose,
          model: request.model,
          source: 'live',
          promptHash: prompt.hash,
          promptChars: prompt.chars,
          responseHash: shortHash(text),
          responseChars: text.length,
          nativeToolCalls: native.length,
          durationMs: Date.now() - started,
          ...(error ? { error } : {})
        },
        {
          seq,
          purpose: request.purpose,
          text,
          ...(native.length ? { nativeToolCalls: native } : {}),
          ...(error ? { error } : {})
        }
      )
    }
  }
}

/** Rebuild per-purpose scripts from stored replies, in their original order. */
export function scriptFromRecorded(replies: RecordedReply[]): ScriptQueues {
  const queues: ScriptQueues = {}
  for (const reply of [...replies].sort((a, b) => a.seq - b.seq)) {
    const queue = (queues[reply.purpose] ??= [])
    queue.push({
      text: reply.text,
      ...(reply.nativeToolCalls ? { nativeToolCalls: reply.nativeToolCalls } : {}),
      ...(reply.error && !reply.hang ? { error: reply.error } : {}),
      ...(reply.hang ? { hang: true } : {})
    })
  }
  return queues
}
