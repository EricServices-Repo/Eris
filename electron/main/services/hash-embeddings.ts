import { createHash } from 'crypto'

export const EMBED_DIMS = 128
const STOP = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'are',
  'was',
  'were',
  'you',
  'your',
  'have',
  'has',
  'not',
  'but',
  'use',
  'using',
  'into',
  'out'
])
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .slice(0, 400)
}
export function normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0))
  return mag === 0 ? vec : vec.map((n) => n / mag)
}
export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0)
  for (const token of tokenize(text))
    vec[createHash('sha256').update(token).digest().readUInt16BE(0) % EMBED_DIMS]++
  return normalize(vec)
}
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  return a.reduce((sum, n, i) => sum + n * (b[i] ?? 0), 0)
}
