import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn())
vi.mock('../electron/main/services/shell-run', () => ({ runWorkspaceCommand: run }))
vi.mock('../electron/main/services/model-transport', () => ({ activeDiagnosticsScope: () => null }))
import { runVerify } from '../electron/main/services/verify'

const root = mkdtempSync(join(tmpdir(), 'eris-empty-verify-'))
writeFileSync(join(root, 'package.json'), JSON.stringify({
  scripts: { test: 'react-scripts test' }, dependencies: { 'react-scripts': '1' }
}))
afterEach(() => run.mockReset())
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('marks a successful zero-test CRA invocation as skipped', async () => {
  run.mockResolvedValue({ ok: true, timedOut: false, code: 0, stdout: 'No tests found, exiting with code 0', stderr: '' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result).toMatchObject({ ok: true, skipped: true })
  expect(result.detail).toContain('no test files found')
  expect(result.check).toMatchObject({ kind: 'test', status: 'skipped', testCount: 0, requirementIds: [] })
})

it('reports a completed test suite as passed', async () => {
  run.mockResolvedValue({ ok: true, timedOut: false, code: 0, stdout: 'Tests: 2 passed, 2 total', stderr: '' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result.ok).toBe(true)
  expect(result.check).toMatchObject({ kind: 'test', status: 'passed', testCount: 2, requirementIds: [] })
  expect(result.skipped).toBeUndefined()
})

it.each([
  ['No test files found, exiting with code 0', 0, 'skipped'],
  ['Tests  4 passed | 1 skipped (5)', 5, 'passed'],
  ['Tests  2 skipped (2)', 0, 'skipped'],
  ['TAP version 13\n1..0\n# tests 0', 0, 'skipped'],
  ['# tests 3\n# pass 0\n# fail 0\n# skipped 2\n# todo 1', 0, 'skipped'],
  ['ℹ tests 2\nℹ pass 1\nℹ fail 0\nℹ skipped 1\nℹ todo 0', 2, 'passed']
] as const)('records project evidence from %s without inferring relevance', async (stdout, testCount, status) => {
  const project = mkdtempSync(join(tmpdir(), 'eris-test-evidence-'))
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    run.mockResolvedValue({ ok: true, timedOut: false, code: 0, stdout, stderr: '' })
    const result = await runVerify(project, undefined, { allowInstall: false })
    expect(result.check).toMatchObject({ kind: 'test', status, testCount, requirementIds: [] })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

it('does not hide a timeout as a skipped suite', async () => {
  run.mockResolvedValue({ ok: false, timedOut: true, code: null, stdout: 'No tests found', stderr: '' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result.ok).toBe(false)
  expect(result.skipped).toBeUndefined()
})

it('classifies a typecheck as project evidence without claiming behavior coverage', async () => {
  const project = mkdtempSync(join(tmpdir(), 'eris-typecheck-evidence-'))
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    run.mockResolvedValue({ ok: true, timedOut: false, code: 0, stdout: 'No tests found', stderr: '' })
    const result = await runVerify(project, undefined, { allowInstall: false })
    expect(result.check).toMatchObject({
      kind: 'typecheck', scope: 'project', status: 'passed', command: 'npm run typecheck', requirementIds: []
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

it('preserves a real process failure even when its output mentions an empty suite', async () => {
  run.mockResolvedValue({ ok: false, timedOut: false, code: 2, stdout: 'No tests found', stderr: 'Invalid configuration' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result.check).toMatchObject({ kind: 'test', status: 'failed', requirementIds: [] })
  expect(result.skipped).toBeUndefined()
})
