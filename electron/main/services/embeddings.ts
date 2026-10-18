import type { AppSettings } from '../../../src/shared/settings-schema'
import { isBuiltinRef } from './builtin-model'
import { resolveConnectionForModel } from './model-catalog'
import { hashEmbed, normalize } from './hash-embeddings'
export { EMBED_DIMS, tokenize, hashEmbed, normalize, cosine } from './hash-embeddings'

export async function embedText(
  text: string,
  settings?: AppSettings,
  getSecret?: (key: string) => string | null
): Promise<number[]> {
  const local = hashEmbed(text)
  if (!settings || !getSecret) return local
  const provider = settings.intelligence.embeddingProvider
  const model = settings.intelligence.embeddingModel.trim()
  if (provider === 'local' || !model || isBuiltinRef(model)) return local
  const connection = resolveConnectionForModel(settings, model)
  if (!connection || connection.type !== 'openai-compatible' || !connection.baseUrl) return local
  try {
    const root = connection.baseUrl.replace(/\/$/, '')
    const url = root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`
    const apiKey = connection.apiKeyRef ? getSecret(connection.apiKeyRef) : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text.slice(0, 8000) })
    })
    if (!res.ok) return local
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
    const embedding = data.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length === 0) return local
    return normalize(embedding.map((n) => Number(n) || 0))
  } catch {
    return local
  }
}
