import { describe, expect, it } from 'vitest'
import {
  bestRankFusion,
  fuseRankings,
  measureEmbeddingRecall,
  rankByEmbedding,
  type Embedder
} from '../checks/embedding-recall'
import { measureParaphraseRecall, PARAPHRASE_CASES } from '../checks/paraphrase-recall'
import type { EmbeddingSpace } from '../src/shared/embedding-space'

const SPACE: EmbeddingSpace = {
  indexVersion: 1,
  provider: 'test',
  model: 'oracle',
  dimensions: 2,
  tokenizer: 'none'
}
/** Puts every case's source first and everything else level: a perfect embedding model. */
const sources = new Set(PARAPHRASE_CASES.map((c) => c.source))
const oracle: Embedder = {
  space: SPACE,
  query: async () => ({ vector: [1, 0], space: SPACE }),
  document: async (text) => ({ vector: sources.has(text) ? [1, 0] : [0, 1], space: SPACE })
}

describe('embedding recall gain measurement (#234)', () => {
  it('without a model, every merged ranking is the lexical one', async () => {
    const report = await measureEmbeddingRecall(null)
    const lexical = await measureParaphraseRecall()
    expect(report.evidence).toBe('deterministic-lexical')
    expect(report.paraphrased.lexical.misses).toEqual(lexical.paraphrased.misses)
    for (const row of report.rows) {
      expect(row.hybrid).toBe(row.lexical)
      expect(row.bestRank).toBe(row.lexical)
      expect(row.embedding).toBeNull()
    }
    expect(fuseRankings(['a', 'b'], null)).toEqual(['a', 'b'])
    expect(bestRankFusion(['a', 'b'], null)).toEqual(['a', 'b'])
  })

  it('never compares vectors from another model or dimension', () => {
    const query = { vector: [1, 0], space: SPACE }
    expect(() =>
      rankByEmbedding(query, [{ id: 'x', vector: [1, 0], space: { ...SPACE, model: 'other' } }])
    ).toThrow(/space mismatch/)
    expect(() => rankByEmbedding(query, [{ id: 'x', vector: [1, 0, 0], space: SPACE }])).toThrow(
      /space mismatch/
    )
  })

  it('records the fusion finding: RRF cannot lift a source lexical recall missed', async () => {
    const report = await measureEmbeddingRecall(oracle)
    expect(report.paraphrased.embedding?.recallAt1).toBe(1)
    // Best rank lets the embedding's first hit compete with lexical's first hit.
    expect(report.paraphrased.bestRank?.recallAt3).toBe(1)
    // RRF ranks anything both lists returned above anything only one did, so a source that
    // lexical recall missed stays behind every lexical result.
    expect(report.paraphrased.hybrid!.recallAt3).toBeLessThan(1)
    for (const id of report.paraphrased.lexical.misses)
      expect(report.paraphrased.hybrid!.misses).toContain(id)
  })
})
