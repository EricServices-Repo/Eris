import { createHash } from 'crypto'
import type { AppSettings } from '../../../src/shared/settings-schema'
import { isBuiltinRef } from './builtin-model'
import { resolveConnectionForModel } from './model-catalog'

export const EMBED_DIMS = 128

const STOP = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were',
  'you', 'your', 'have', 'has', 'not', 'but', 'use', 'using', 'into', 'out'
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .slice(0, 400)
}

function bucket(token: string): number {
  const hex = createHash('sha256').update(token).digest()
  return hex.readUInt16BE(0) % EMBED_DIMS
}

/** Deterministic hashed bag-of-words vector (no network, no extra model). */
export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0)
  for (const token of tokenize(text)) {
    vec[bucket(token)] += 1
  }
  return normalize(vec)
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

export function normalize(vec: number[]): number[] {
  let sum = 0
  for (const n of vec) sum += n * n
  const mag = Math.sqrt(sum)
  if (mag === 0) return vec
  return vec.map((n) => n / mag)
}

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
