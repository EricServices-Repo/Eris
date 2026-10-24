import { URL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runQuality, assessQuality, digest, adjudicateReport } from '../../scripts/run-quality.mjs'
const pack = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
const result = {
  answer: '[-2,1,3]',
  completion: 'complete',
  effectiveSettings: { context: 8192, temperature: 0 },
  usage: { outputTokens: 5, source: 'measured' }
}
test('all requested quality strata have independent obligations', () => {
  for (const stratum of [
    'answer',
    'code-example',
    'patch',
    'review',
    'execution',
    'follow-up',
    'security'
  ])
    assert.ok(pack.cases.some((item) => item.stratum === stratum && item.obligations.length))
})
test('syntax and topic words cannot establish correctness', () => {
  assert.equal(assessQuality(pack.cases[0], result).state, 'unresolved')
  assert.equal(assessQuality(pack.cases[1], result).state, 'correct')
  assert.equal(assessQuality(pack.cases[1], { ...result, answer: '[1,2,3]' }).state, 'incorrect')
  assert.equal(
    assessQuality(pack.cases[1], { ...result, completion: 'incomplete' }).state,
    'unresolved'
  )
})
test('human decisions bind the exact observed result', () => {
  const vote = {
    state: 'correct',
    reviewer: 'fixture-reviewer',
    rationale: 'Checked both interleavings',
    resultDigest: digest(result)
  }
  assert.equal(assessQuality(pack.cases[0], result, vote).state, 'correct')
  assert.equal(
    assessQuality(pack.cases[0], { ...result, answer: 'changed' }, vote).state,
    'unresolved'
  )
})
test('live calls are opt-in and repeated models share a hard reservation budget', async () => {
  let calls = 0
  const adapter = {
    kind: 'live',
    run: async () => {
      calls++
      return result
    }
  }
  await assert.rejects(
    runQuality({ pack, models: ['a'], maxCalls: 2, maxOutputTokens: 8192, adapter }),
    /--live/
  )
  assert.equal(calls, 0)
  const report = await runQuality({
    pack,
    models: ['a', 'b'],
    repeats: 2,
    maxCalls: 2,
    maxOutputTokens: 8192,
    adapter: { ...adapter, kind: 'scripted' }
  })
  assert.equal(report.calls, 2)
  assert.equal(report.rows.length, 40)
  assert.equal(report.reservedOutputTokens, 8192)
  assert.ok(report.rows.some((row) => row.status === 'budget-skipped'))
})

test('offline adjudication binds existing evidence without reaching an adapter', () => {
  const report = {
    packDigest: digest(pack),
    calls: 1,
    rows: [
      {
        key: 'answer-generic:a:0',
        caseId: 'answer-generic',
        status: 'observed',
        result,
        resultDigest: digest(result)
      }
    ]
  }
  const decisions = {
    'answer-generic:a:0': {
      state: 'correct',
      reviewer: 'fixture',
      rationale: 'Independent review',
      resultDigest: digest(result)
    }
  }
  assert.equal(adjudicateReport(report, pack, decisions).rows[0].correctness.state, 'correct')
  assert.throws(
    () => adjudicateReport({ ...report, packDigest: 'changed' }, pack, decisions),
    /fixture digest/
  )
})
