/**
 * RAM-CTX-062 (#234) gain measurement: does a CPU embedding model recover what lexical
 * recall misses on the labelled paraphrase set? It runs the same threads as
 * paraphrase-recall.ts and reports three rankings per case:
 *
 *   lexical    the production ContextMemoryStore.select order (unchanged)
 *   embedding  every thread message by cosine similarity to the query
 *   hybrid     lexical and embedding merged by reciprocal rank fusion (RRF)
 *   bestRank   lexical and embedding merged by each source's best rank in either list
 *
 * The two merges are candidate readings of §12.9's "results merge into the existing
 * ranking". They differ in whether a source only embeddings found can outrank one that
 * lexical recall also returned.
 *
 * The embedder is injected. Tests pass a deterministic one; scripts/measure-embedding-
 * recall.mjs passes a real GGUF embedding model with the GPU disabled.
 */
import { sameEmbeddingSpace, type EmbeddingSpace } from '../src/shared/embedding-space'
import {
  PARAPHRASE_CASES,
  lexicalRanking,
  paraphraseThread,
  type ParaphraseCase,
  type ParaphraseCategory
} from './paraphrase-recall'

export type EmbeddedText = { vector: number[]; space: EmbeddingSpace }
export type Embedder = {
  space: EmbeddingSpace
  query(text: string): Promise<EmbeddedText>
  document(text: string): Promise<EmbeddedText>
}

/** Standard RRF constant: a rank's weight falls slowly, so neither list dominates. */
export const RRF_K = 60
type K = 1 | 3 | 5

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Ranks documents by similarity to the query. Refuses vectors from another space
 * (model, version, dimension or tokenizer): such scores mean nothing.
 */
export function rankByEmbedding(
  query: EmbeddedText,
  documents: Array<{ id: string } & EmbeddedText>
): string[] {
  for (const doc of documents)
    if (!sameEmbeddingSpace(doc.space, query.space) || doc.vector.length !== query.vector.length)
      throw new Error(`Embedding space mismatch for ${doc.id}; vectors are not comparable`)
  return documents
    .map((doc) => ({ id: doc.id, score: cosine(query.vector, doc.vector) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((doc) => doc.id)
}

/** Reciprocal rank fusion. With no embedding list the lexical order comes back unchanged. */
export function fuseRankings(lexical: string[], embedding: string[] | null): string[] {
  if (!embedding) return [...lexical]
  const score = new Map<string, number>()
  for (const list of [lexical, embedding])
    list.forEach((id, index) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + index + 1)))
  const lexicalIndex = (id: string) => {
    const index = lexical.indexOf(id)
    return index < 0 ? Infinity : index
  }
  return [...score.keys()].sort(
    (a, b) => score.get(b)! - score.get(a)! || lexicalIndex(a) - lexicalIndex(b)
  )
}

/**
 * Each source takes its best rank in either list; ties go to the better other rank, then
 * lexical order. A source only one list found competes on that rank alone.
 */
export function bestRankFusion(lexical: string[], embedding: string[] | null): string[] {
  if (!embedding) return [...lexical]
  const rank = (list: string[], id: string) => {
    const index = list.indexOf(id)
    return index < 0 ? Infinity : index
  }
  const ids = [...new Set([...lexical, ...embedding])]
  const key = (id: string) => {
    const a = rank(lexical, id),
      b = rank(embedding, id)
    return [Math.min(a, b), Math.max(a, b), a] as const
  }
  return ids.sort((x, y) => {
    const a = key(x),
      b = key(y)
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  })
}

export type EmbeddingRecallRow = {
  id: string
  category: ParaphraseCategory
  lexical: number | null
  embedding: number | null
  hybrid: number | null
  bestRank: number | null
  distractor: {
    lexical: number | null
    embedding: number | null
    hybrid: number | null
    bestRank: number | null
  }
}

const rankIn = (list: string[], id: string) => {
  const index = list.indexOf(id)
  return index < 0 ? null : index + 1
}

export async function measureEmbeddingRecall(
  embedder: Embedder | null,
  cases: ParaphraseCase[] = PARAPHRASE_CASES
) {
  const rows: EmbeddingRecallRow[] = []
  const queryMs: number[] = []
  const documentMs: number[] = []
  for (const c of cases) {
    const lexical = await lexicalRanking(c)
    let embedding: string[] | null = null
    if (embedder) {
      const documents = []
      for (const message of paraphraseThread(c)) {
        const started = performance.now()
        documents.push({ id: message.id, ...(await embedder.document(message.content)) })
        documentMs.push(performance.now() - started)
      }
      const started = performance.now()
      const query = await embedder.query(c.query)
      queryMs.push(performance.now() - started)
      embedding = rankByEmbedding(query, documents)
    }
    const hybrid = fuseRankings(lexical, embedding)
    const best = bestRankFusion(lexical, embedding)
    rows.push({
      id: c.id,
      category: c.category,
      lexical: rankIn(lexical, 'source'),
      embedding: embedding ? rankIn(embedding, 'source') : null,
      hybrid: rankIn(hybrid, 'source'),
      bestRank: rankIn(best, 'source'),
      distractor: {
        lexical: rankIn(lexical, 'distractor'),
        embedding: embedding ? rankIn(embedding, 'distractor') : null,
        hybrid: rankIn(hybrid, 'distractor'),
        bestRank: rankIn(best, 'distractor')
      }
    })
  }
  const summarize = (
    subset: EmbeddingRecallRow[],
    key: 'lexical' | 'embedding' | 'hybrid' | 'bestRank'
  ) => {
    const at = (k: K) =>
      subset.length
        ? subset.filter((row) => row[key] !== null && row[key]! <= k).length / subset.length
        : 0
    return {
      recallAt1: at(1),
      recallAt3: at(3),
      recallAt5: at(5),
      misses: subset.filter((row) => row[key] === null || row[key]! > 5).map((row) => row.id)
    }
  }
  const group = (subset: EmbeddingRecallRow[]) => ({
    cases: subset.length,
    lexical: summarize(subset, 'lexical'),
    ...(embedder
      ? {
          embedding: summarize(subset, 'embedding'),
          hybrid: summarize(subset, 'hybrid'),
          bestRank: summarize(subset, 'bestRank')
        }
      : {})
  })
  const percentile = (values: number[], p: number) => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! * 10) / 10
  }
  const categories = [...new Set(cases.map((c) => c.category))]
  return {
    version: 1 as const,
    evidence: embedder ? ('model-embedding' as const) : ('deterministic-lexical' as const),
    space: embedder?.space ?? null,
    fusion: { hybrid: { method: 'reciprocal-rank', k: RRF_K }, bestRank: { method: 'best-rank' } },
    /** Misses count anything not in the top 5, the depth push recall can afford. */
    missDepth: 5,
    byCategory: Object.fromEntries(
      categories.map((category) => [category, group(rows.filter((r) => r.category === category))])
    ) as Record<ParaphraseCategory, ReturnType<typeof group>>,
    paraphrased: group(rows.filter((row) => row.category !== 'lexical-control')),
    latencyMs: embedder
      ? {
          queryP50: percentile(queryMs, 0.5),
          queryP95: percentile(queryMs, 0.95),
          documentP50: percentile(documentMs, 0.5),
          documentP95: percentile(documentMs, 0.95),
          documents: documentMs.length
        }
      : null,
    rows
  }
}
