import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('./mocks/electron')>('./mocks/electron')
  return { ...actual, app: { ...actual.app, getLocale: () => 'en-US' } }
})
vi.mock('../electron/main/ipc/shared', () => ({ getSecret: () => null }))
import { formatBuildIdentity, runtimeBuildIdentity } from '../electron/main/services/build-identity'
import { buildBugReportPreview } from '../electron/main/services/bug-report'

const stamp = {
  gitSha: '2e856a1aaaaabbbbbccccdddddeeeeefffff0000',
  dirty: false,
  lockSha256: 'f'.repeat(64),
  buildId: '2026-11-09T00:00:00.000Z-ab12cd34'
}

describe('runtime build identity (#473)', () => {
  it('reports the baked stamp, not the checkout on disk', () => {
    const id = runtimeBuildIdentity(stamp)
    expect(id).toMatchObject({
      gitSha: stamp.gitSha,
      dirty: false,
      buildId: stamp.buildId,
      provenance: 'injected'
    })
    expect(formatBuildIdentity(id)).toContain('2e856a1aaaaa')
    expect(formatBuildIdentity(id)).toContain(stamp.buildId)
  })
  it('stays explicitly unknown without a stamp instead of claiming a clean build', () => {
    const id = runtimeBuildIdentity(undefined)
    expect(id).toMatchObject({
      gitSha: 'unknown',
      dirty: null,
      buildId: 'unknown',
      provenance: 'unknown'
    })
    expect(formatBuildIdentity(id)).toContain('unverified')
  })
  it('distinguishes two builds of the same commit', () => {
    const a = runtimeBuildIdentity(stamp)
    const b = runtimeBuildIdentity({ ...stamp, buildId: '2026-11-10T00:00:00.000Z-99999999' })
    expect(a.gitSha).toBe(b.gitSha)
    expect(formatBuildIdentity(a)).not.toBe(formatBuildIdentity(b))
  })
})

describe('feedback export carries build identity', () => {
  const input = { title: 'x', description: 'y', includeLogs: false }
  it('includes a machine-readable identity block with a trace ID', () => {
    const preview = buildBugReportPreview({ ...input, includeDiagnostics: true })
    const json = /```json\n([\s\S]*?)\n```/.exec(preview.body)?.[1]
    expect(json).toBeTruthy()
    const parsed = JSON.parse(json!)
    expect(parsed.schema).toBe('eris-feedback-identity/1')
    expect(parsed.traceId).toBe(preview.diagnostics.traceId)
    expect(parsed.build).toMatchObject({ gitSha: expect.any(String), buildId: expect.any(String) })
    expect(preview.body).toContain('| Build |')
    expect(preview.body).toContain('| Trace ID |')
  })
  it('keeps the identity block even when diagnostics are excluded, without project or model', () => {
    const preview = buildBugReportPreview({ ...input, includeDiagnostics: false })
    const parsed = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(preview.body)![1]!)
    expect(parsed.build).toBeTruthy()
    expect(parsed).not.toHaveProperty('activeProject')
    expect(parsed).not.toHaveProperty('defaultModel')
    expect(preview.body).not.toContain('## Environment')
  })
  it('never puts filesystem paths or the log directory in the identity block', () => {
    const preview = buildBugReportPreview({ ...input, includeDiagnostics: true })
    const json = /```json\n([\s\S]*?)\n```/.exec(preview.body)![1]!
    expect(json).not.toContain(preview.diagnostics.logDirectory)
    expect(json).not.toMatch(/\/Users\/|[A-Z]:\\\\/)
  })
  it('uses a fresh trace ID per report', () => {
    const a = buildBugReportPreview(input).diagnostics.traceId
    const b = buildBugReportPreview(input).diagnostics.traceId
    expect(a).not.toBe(b)
  })
})
