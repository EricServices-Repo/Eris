import type { AppSettings } from '../../../src/shared/settings-schema'
import { HASH_EMBEDDING_SPACE, type EmbeddingSpace } from '../../../src/shared/embedding-space'
import { isBuiltinRef } from './builtin-model'
import { resolveConnectionForModel } from './model-catalog'
import { hashEmbed, normalize } from './hash-embeddings'
export { EMBED_DIMS, tokenize, hashEmbed, normalize, cosine } from './hash-embeddings'

export type EmbeddingResult = {
  vector: number[]
  space: EmbeddingSpace
  remoteTransfer: boolean
  fallback?:
    'policy-disabled' | 'not-configured' | 'provider-error' | 'timeout' | 'invalid-response'
}
/** Standalone optional utility. Workspace ranking never compares its result with hash vectors. */
export async function embedText(
  text: string,
  settings?: AppSettings,
  getSecret?: (key: string) => string | null,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    transfer?: 'query' | 'workspace-content'
  } = {}
): Promise<EmbeddingResult> {
  options.signal?.throwIfAborted()
  const local = (
    fallback?: EmbeddingResult['fallback'],
    remoteTransfer = false
  ): EmbeddingResult => ({
    vector: hashEmbed(text),
    space: HASH_EMBEDDING_SPACE,
    remoteTransfer,
    ...(fallback ? { fallback } : {})
  })
  if (!settings || !getSecret || settings.intelligence.embeddingProvider === 'local') return local()
  const policy = settings.intelligence.remoteEmbeddingPolicy ?? 'disabled'
  // Unknown input classification is source content, not automatically a harmless query.
  if (policy === 'disabled' || (policy === 'queries-only' && options.transfer !== 'query'))
    return local('policy-disabled')
  const model = settings.intelligence.embeddingModel.trim()
  const connection =
    model && !isBuiltinRef(model) ? resolveConnectionForModel(settings, model) : null
  if (!connection || connection.type !== 'openai-compatible' || !connection.baseUrl)
    return local('not-configured')
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(),
    Math.max(50, Math.min(30000, options.timeoutMs ?? 5000))
  )
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  let transferred = false
  try {
    const root = connection.baseUrl.replace(/\/$/, '')
    const url = root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`
    const apiKey = connection.apiKeyRef ? getSecret(connection.apiKeyRef) : null
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    transferred = true
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ model, input: text.slice(0, 8000) })
    })
    if (!res.ok) {
      await res.body?.cancel()
      return local('provider-error', true)
    }
    const reader = res.body?.getReader()
    if (!reader) return local('invalid-response', true)
    let bytes = 0
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 1024 * 1024) {
          await reader.cancel()
          return local('invalid-response', true)
        }
        chunks.push(part.value)
      }
    } finally {
      reader.releaseLock()
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vector = data.data?.[0]?.embedding
    if (
      !Array.isArray(vector) ||
      !vector.length ||
      vector.length > 16384 ||
      !vector.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
      !vector.some((n) => n !== 0)
    )
      return local('invalid-response', true)
    const normalized = normalize(vector)
    if (!normalized.every(Number.isFinite) || !normalized.some((n) => n !== 0))
      return local('invalid-response', true)
    return {
      vector: normalized,
      remoteTransfer: true,
      space: {
        indexVersion: 2,
        provider: connection.id,
        model,
        dimensions: vector.length,
        tokenizer: 'provider-defined-input8000-v1'
      }
    }
  } catch {
    options.signal?.throwIfAborted()
    return local(timeout.signal.aborted ? 'timeout' : 'provider-error', transferred)
  } finally {
    clearTimeout(timer)
  }
}
