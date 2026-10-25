export const MAX_MODEL_EVENT_BYTES = 1024 * 1024
export const MAX_MODEL_STREAM_BYTES = 16 * 1024 * 1024
export class ModelStreamError extends Error {
  constructor(
    readonly code: 'MODEL_STREAM_PROTOCOL_ERROR' | 'MODEL_STREAM_LIMIT' | 'MODEL_STREAM_INCOMPLETE',
    message: string
  ) {
    super(message)
    this.name = 'ModelStreamError'
  }
}

/** Bounded SSE data events, including CRLF and a final event without its newline. */
export async function* modelSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const decode = (bytes?: Uint8Array, stream = false) => {
    try {
      return decoder.decode(bytes, { stream })
    } catch {
      throw new ModelStreamError(
        'MODEL_STREAM_PROTOCOL_ERROR',
        'Model stream contains invalid UTF-8.'
      )
    }
  }
  let buffer = '',
    data: string[] = [],
    eventBytes = 0,
    streamBytes = 0
  function line(value: string): string | null {
    if (Buffer.byteLength(value) > MAX_MODEL_EVENT_BYTES)
      throw new ModelStreamError('MODEL_STREAM_LIMIT', 'Model SSE line exceeds its size limit.')
    if (!value) {
      const event = data.length ? data.join('\n') : null
      data = []
      eventBytes = 0
      return event
    }
    // Comments and SSE metadata are not model payloads.
    if (value.startsWith(':')) return null
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    if (field !== 'data') return null
    const text = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    eventBytes += Buffer.byteLength(text) + 1
    if (eventBytes > MAX_MODEL_EVENT_BYTES)
      throw new ModelStreamError('MODEL_STREAM_LIMIT', 'Model SSE event exceeds its size limit.')
    data.push(text)
    return null
  }
  function* consume(final = false): Generator<string> {
    for (;;) {
      const boundary = buffer.search(/[\r\n]/)
      if (boundary < 0 || (!final && boundary === buffer.length - 1 && buffer[boundary] === '\r'))
        break
      const text = buffer.slice(0, boundary)
      const width = buffer[boundary] === '\r' && buffer[boundary + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(boundary + width)
      const event = line(text)
      if (event !== null) yield event
    }
    if (Buffer.byteLength(buffer) > MAX_MODEL_EVENT_BYTES)
      throw new ModelStreamError(
        'MODEL_STREAM_LIMIT',
        'Unterminated model SSE line exceeds its size limit.'
      )
    if (final) {
      if (buffer) {
        const event = line(buffer)
        if (event !== null) yield event
        buffer = ''
      }
      const event = line('')
      if (event !== null) yield event
    }
  }
  for (;;) {
    signal?.throwIfAborted()
    const part = await reader.read()
    signal?.throwIfAborted()
    if (part.done) break
    streamBytes += part.value.byteLength
    if (streamBytes > MAX_MODEL_STREAM_BYTES)
      throw new ModelStreamError('MODEL_STREAM_LIMIT', 'Model stream exceeds its total byte limit.')
    buffer += decode(part.value, true)
    yield* consume()
  }
  buffer += decode()
  yield* consume(true)
}
