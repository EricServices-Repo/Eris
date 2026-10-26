import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runScenarios, assessScenarioTurn, arithmeticOracle, scenarioDigest } from './scenarios.mjs'
const pack = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'))
const one = { ...pack, families: [pack.families[0]] }
function scripted() {
  const seen = [],
    closed = []
  return {
    kind: 'scripted',
    callsPerTurn: 1,
    seen,
    closed,
    async start({ family, model, repeat }) {
      let files = { ...family.fixture }
      return {
        async turn(input) {
          seen.push({ model, repeat, ...structuredClone(input) })
          if (input.index === 2)
            files = {
              'math.js':
                'export function increment(n) { return n + 1 }\nexport function double(n) { return n * 2 }\nexport function negate(n) { return -n }\n'
            }
          return {
            answer: `real output ${input.index}`,
            task: { taskId: `task-${input.index}` },
            completion: 'complete',
            files: { ...files },
            calls: 0,
            execution: { state: 'none' }
          }
        },
        async close() {
          closed.push(model)
        }
      }
    }
  }
}
const config = (adapter) => ({
  pack: one,
  models: ['a', 'b'],
  repeats: 2,
  maxCalls: 32,
  maxOutputTokens: 131072,
  adapter
})
test('state and actual prior answers survive review, selection, patch and explanation', async () => {
  const adapter = scripted(),
    report = await runScenarios(config(adapter))
  assert.equal(report.rows.length, 16)
  assert.equal(adapter.closed.length, 4)
  const second = adapter.seen[1],
    fourth = adapter.seen[3]
  assert.deepEqual(second.history, [
    { role: 'user', content: one.families[0].turns[0].heldout },
    { role: 'assistant', content: 'real output 0' }
  ])
  assert.equal(second.priorTask.taskId, 'task-0')
  assert.equal(fourth.history.length, 6)
  assert.equal(report.rows[2].axes.completeness.recommendations.length, 3)
  assert.ok(report.rows[2].axes.completeness.recommendations.every((r) => r.state === 'correct'))
  assert.equal(report.rows[3].changes.length, 0)
  assert.equal(report.coverage.generalQualityPassRate, null)
  assert.equal(report.coverage.unresolved, 16)
  assert.equal(report.budget.observedCalls, 0)
})
test('each selected fix fails independently despite plausible topic words', () => {
  const turn = one.families[0].turns[2]
  const result = {
    answer: 'increment double all fixed tests passed',
    completion: 'complete',
    files: {
      'math.js':
        'export function increment(n) {return n+1}\nexport function double(n) {return n+2}\nexport function negate(n) {return -n}'
    }
  }
  const grade = assessScenarioTurn(turn, result, one.families[0].fixture)
  assert.deepEqual(
    grade.axes.completeness.recommendations.map((r) => r.state),
    ['correct', 'incorrect', 'correct']
  )
  assert.equal(grade.axes.correctness.state, 'unresolved')
})
test('generated code cannot execute host APIs through the arithmetic oracle', () => {
  globalThis.__erisOracleSideEffect = false
  assert.equal(
    arithmeticOracle(
      'export function increment(n) { return (globalThis.__erisOracleSideEffect=true) }',
      'increment',
      [[0, 1]]
    ).state,
    'unresolved'
  )
  assert.equal(globalThis.__erisOracleSideEffect, false)
  delete globalThis.__erisOracleSideEffect
})
test('review-only authority and execution are separate observed axes', () => {
  const turn = one.families[0].turns[0],
    result = {
      files: { 'math.js': 'changed' },
      execution: { state: 'executed' },
      answer: 'review',
      completion: 'complete'
    }
  const grade = assessScenarioTurn(turn, result, one.families[0].fixture)
  assert.deepEqual(grade.axes.authority, { edit: 'violation', execution: 'violation' })
  assert.equal(grade.axes.correctness.state, 'unresolved')
})
test('human judgments bind exact pack and result, with reviewer and rationale', () => {
  const turn = one.families[0].turns[0],
    result = { answer: 'a', files: one.families[0].fixture },
    packDigest = scenarioDigest(one)
  const decision = {
    state: 'correct',
    reviewer: 'independent reviewer',
    rationale: 'Reviewed specific evidence',
    resultDigest: scenarioDigest(result),
    packDigest
  }
  assert.equal(
    assessScenarioTurn(turn, result, {}, decision, packDigest).axes.correctness.state,
    'correct'
  )
  assert.equal(
    assessScenarioTurn(turn, { ...result, answer: 'changed' }, {}, decision, packDigest).axes
      .correctness.state,
    'unresolved'
  )
  assert.equal(
    assessScenarioTurn(turn, result, {}, decision, 'another-pack').axes.correctness.state,
    'unresolved'
  )
})
test('live runs require opt-in and reservations include internal provider calls', async () => {
  const adapter = { ...scripted(), kind: 'live', callsPerTurn: 6 }
  await assert.rejects(runScenarios(config(adapter)), /opt-in/)
  const report = await runScenarios({
    ...config(adapter),
    live: true,
    maxCalls: 6,
    maxOutputTokens: 768
  })
  assert.equal(report.budget.reservedCalls, 6)
  assert.equal(report.budget.reservedOutputTokens, 768)
  assert.equal(report.rows.filter((r) => r.status === 'budget-skipped').length, 15)
})
test('provider faults retain unknown call accounting and stop dependent follow-ups', async () => {
  const adapter = {
    kind: 'live',
    callsPerTurn: 2,
    async start() {
      return {
        async turn() {
          const error = new Error('provider disconnected')
          error.code = 'provider-error'
          throw error
        },
        async close() {}
      }
    }
  }
  const report = await runScenarios({ ...config(adapter), models: ['a'], repeats: 1, live: true })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].attribution, 'provider-error')
  assert.equal(report.budget.observedCalls, null)
  assert.equal(report.coverage.completedTurns, 0)
})
test('deadline aborts owned session and preserves failure attribution', async () => {
  let aborted = false,
    closed = false
  const adapter = {
    kind: 'scripted',
    callsPerTurn: 1,
    async start() {
      return {
        async turn({ signal }) {
          await new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                resolve()
              },
              { once: true }
            )
          )
          throw new Error('aborted')
        },
        async close() {
          closed = true
        }
      }
    }
  }
  const report = await runScenarios({
    ...config(adapter),
    models: ['a'],
    repeats: 1,
    timeoutMs: 100
  })
  assert.ok(aborted && closed)
  assert.equal(report.rows[0].attribution, 'deadline')
})
test('held-out prompts differ and seeded matrix identity is repeatable', async () => {
  assert.ok(pack.families.length > 7)
  for (const f of pack.families) for (const t of f.turns) assert.notEqual(t.prompt, t.heldout)
  const opts = {
    ...config(scripted()),
    pack,
    repeats: 1,
    maxCalls: 100,
    maxOutputTokens: 409600,
    seed: 'same'
  }
  const a = await runScenarios(opts),
    b = await runScenarios({ ...opts, adapter: scripted() })
  assert.deepEqual(
    a.rows.map((r) => r.key),
    b.rows.map((r) => r.key)
  )
  assert.ok(a.coverage.byStratum['missing-project'] > 0)
  assert.ok(a.coverage.byStratum['applicability'] > 0)
})
