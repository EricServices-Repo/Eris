/** Vector identity is a compatibility contract, not a claim of semantic quality. */
export type EmbeddingSpace = {
  indexVersion: number
  provider: string
  model: string
  dimensions: number
  tokenizer: string
}
export const HASH_EMBEDDING_SPACE: EmbeddingSpace = Object.freeze({
  indexVersion: 2,
  provider: 'local',
  model: 'sha256-token-hash',
  dimensions: 128,
  tokenizer: 'ascii-lower-stop-v1-first400-source6000'
})
export function sameEmbeddingSpace(a: EmbeddingSpace | undefined, b: EmbeddingSpace): boolean {
  return !!a && (Object.keys(b) as Array<keyof EmbeddingSpace>).every((key) => a[key] === b[key])
}
