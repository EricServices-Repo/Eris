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
