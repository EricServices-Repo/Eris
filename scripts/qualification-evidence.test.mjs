import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qualifyResults } from './qualification-evidence.mjs'
const report = status => ({ success: true, testResults: [{ name: '/repo/tests/a.test.ts', assertionResults: [{ status }] }] })
test('qualification requires every selected file and a nonempty passing assertion set', () => {
  assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], report('passed'), 0).pass, true)
  assert.equal(qualifyResults('/repo', ['tests/a.test.ts', 'tests/b.test.ts'], report('passed'), 0).pass, false)
  assert.equal(qualifyResults('/repo', [], null, 0).pass, false)
})
test('exit failure, failed assertions, skips and todos cannot certify a profile', () => {
  for (const status of ['failed', 'pending', 'todo', 'skipped'])
    assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], report(status), 0).pass, false)
  assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], report('passed'), 1).pass, false)
  assert.equal(qualifyResults('/repo', ['tests/other.test.ts'], report('passed'), 0).pass, false)
})
test('only explicitly named platform exclusions permit skips and remain visible in counts', () => {
  const results = report('passed')
  results.testResults[0].assertionResults.push({ status: 'pending', fullName: 'requires symlinks' })
  const exemption = { file: 'tests/a.test.ts', fullName: 'requires symlinks', reason: 'Platform needs elevated symlink privileges' }
  assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], results, 0).pass, false)
  const qualified = qualifyResults('/repo', ['tests/a.test.ts'], results, 0, [exemption])
  assert.equal(qualified.pass, true)
  assert.equal(qualified.counts.skipped, 1)
  assert.equal(qualified.counts.platformExcluded, 1)
  assert.deepEqual(qualified.exclusions, [exemption])
  for (const changed of [{ ...exemption, reason: '' }, { ...exemption, fullName: 'other' }, { ...exemption, file: 'tests/b.test.ts' }])
    assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], results, 0, [changed]).pass, false)
  results.testResults[0].assertionResults[1].status = 'todo'
  assert.equal(qualifyResults('/repo', ['tests/a.test.ts'], results, 0, [exemption]).pass, false)
})
