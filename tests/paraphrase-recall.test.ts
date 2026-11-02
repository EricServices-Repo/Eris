import { describe, expect, it } from 'vitest'
import { measureParaphraseRecall, PARAPHRASE_CASES } from '../checks/paraphrase-recall'
import { RECALL_RANKING_VERSION } from '../src/shared/recall-terms'

/**
 * #234 measurement gate. The recorded misses are the evidence §12.9 asks for before
 * embeddings are built; docs/fixes/234-paraphrase-recall-measurement.md reports them.
 * A ranking change that moves them must re-record that file, not loosen this test.
 */
const RECORDED = {
  rankingVersion: 2,
  misses: [
    'syn-login',
    'syn-money',
    'syn-crash',
    'syn-cheap',
    'abbr-k8s',
    'desc-login-thing',
    'desc-rounding',
    'desc-flake'
  ]
}

describe('paraphrase recall benchmark (#234)', () => {
  it('has unique, labelled cases with a control set', () => {
    expect(new Set(PARAPHRASE_CASES.map((c) => c.id)).size).toBe(PARAPHRASE_CASES.length)
    expect(PARAPHRASE_CASES.filter((c) => c.category === 'lexical-control').length).toBeGreaterThan(
      4
    )
    for (const c of PARAPHRASE_CASES) expect(c.source).not.toBe(c.distractor)
  })

  it('recalls every lexical control first, so misses measure paraphrase alone', async () => {
    const { byCategory } = await measureParaphraseRecall()
    expect(byCategory['lexical-control']).toMatchObject({ recallAt1: 1, misses: [] })
  })

  it('matches the recorded measurement for the current ranking', async () => {
    const report = await measureParaphraseRecall()
    expect(RECALL_RANKING_VERSION).toBe(RECORDED.rankingVersion)
    expect(report.paraphrased.misses).toEqual(RECORDED.misses)
    expect(report.paraphrased.cases).toBe(22)
    expect(report.evidence).toBe('deterministic-lexical')
  })
})
