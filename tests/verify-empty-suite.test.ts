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
})

it('reports a completed test suite as passed', async () => {
  run.mockResolvedValue({ ok: true, timedOut: false, code: 0, stdout: 'Tests: 2 passed, 2 total', stderr: '' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result.ok).toBe(true)
  expect(result.skipped).toBeUndefined()
})

it('does not hide a timeout as a skipped suite', async () => {
  run.mockResolvedValue({ ok: false, timedOut: true, code: null, stdout: 'No tests found', stderr: '' })
  const result = await runVerify(root, undefined, { allowInstall: false })
  expect(result.ok).toBe(false)
  expect(result.skipped).toBeUndefined()
})
