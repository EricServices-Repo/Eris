import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { evaluateChecks, materializeEvalTask } from '../electron/main/services/eval-runner'
import { bestEvalModelForIntent, scoreEvalResults } from '../electron/main/services/eval-store'
import type { EvalResult, EvalTask } from '../src/shared/evals'

const baseResult = (patch: Partial<EvalResult>): EvalResult => ({
  batchId: 'b',
  taskId: 't',
  taskTitle: 'T',
  source: 'builtin',
  intent: 'edit',
  model: 'builtin:composer-lite',
  agentId: 'composer',
  ok: true,
  checks: [],
  steps: 3,
  toolCalls: 2,
  toolErrors: 0,
  durationMs: 100,
  answer: '',
  at: '2026-01-01T00:00:00.000Z',
  ...patch
})

describe('eval scores', () => {
  it('ranks models by success rate and requires min runs', () => {
    const results = [
      baseResult({ model: 'a', ok: true }),
      baseResult({ model: 'a', ok: true }),
      baseResult({ model: 'a', ok: false }),
      baseResult({ model: 'b', ok: true }),
      baseResult({ model: 'b', ok: true }),
      baseResult({ model: 'b', ok: true })
    ]
    const scores = scoreEvalResults(results)
    expect(scores.find((s) => s.model === 'b')?.successRate).toBe(1)
    expect(bestEvalModelForIntent('edit', ['a', 'b'], 3, results)).toBe('b')
    expect(bestEvalModelForIntent('edit', ['a'], 3, results)).toBe('a')
    expect(bestEvalModelForIntent('run', ['a', 'b'], 3, results)).toBeNull()
  })
})

describe('eval checks', () => {
  const task: EvalTask = {
    id: 'sample',
    title: 'Sample',
    intent: 'edit',
    prompt: 'do it',
    files: { 'a.js': 'export const n = 1\n' },
    checks: [
      { type: 'file_contains', path: 'a.js', text: 'export const n' },
      { type: 'file_exists', path: 'a.js' },
      { type: 'file_absent', path: 'missing.js' },
      { type: 'answer_contains', text: 'done' },
      { type: 'no_changes' }
    ],
    mode: 'agent',
    timeoutMs: 1000
  }

  it('passes when fixtures and answer match', () => {
    const dest = mkdtempSync(join(tmpdir(), 'eris-eval-check-'))
    materializeEvalTask(task, dest)
    const snapshot = { 'a.js': 'export const n = 1\n' }
    const results = evaluateChecks(dest, task.checks, {
      answer: 'DONE',
      snapshot,
      files: task.files
    })
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('fails no_changes when a fixture is edited', () => {
    const dest = mkdtempSync(join(tmpdir(), 'eris-eval-change-'))
    materializeEvalTask(task, dest)
    writeFileSync(join(dest, 'a.js'), 'changed\n')
    const results = evaluateChecks(dest, [{ type: 'no_changes' }], {
      answer: '',
      snapshot: { 'a.js': 'export const n = 1\n' },
      files: task.files
    })
    expect(results[0]?.ok).toBe(false)
  })
})

describe('eval task materialize', () => {
  it('writes nested files', () => {
    const dest = mkdtempSync(join(tmpdir(), 'eris-eval-mat-'))
    materializeEvalTask(
      {
        ...taskLike(),
        files: { 'src/nested/x.ts': 'export const x = 1\n' }
      },
      dest
    )
    mkdirSync(join(dest, 'keep'), { recursive: true })
    expect(() => writeFileSync(join(dest, 'src/nested/x.ts'), 'export const x = 1\n')).not.toThrow()
  })
})

function taskLike(): EvalTask {
  return {
    id: 'x',
    title: 'x',
    intent: 'answer',
    prompt: 'x',
    files: {},
    checks: [{ type: 'answer_contains', text: 'x' }],
    mode: 'ask',
    timeoutMs: 1000
  }
}
