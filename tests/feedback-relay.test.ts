import { readFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('./mocks/electron')>('./mocks/electron')
  return { ...actual, app: { ...actual.app, getLocale: () => 'en-US' } }
})
vi.mock('../electron/main/ipc/shared', () => ({ getSecret: () => null }))
import { submitBugReport, buildBugReportPreview } from '../electron/main/services/bug-report'
afterEach(() => vi.unstubAllGlobals())
const input = {
  title: 'Synthetic regression',
  description: 'Fixture only',
  includeLogs: false,
  includeDiagnostics: false
}
describe('feedback stays on the relay boundary', () => {
  it('requires resource exclusion and scanning in both distributable builders', () => {
    const production = JSON.parse(readFileSync('package.json', 'utf8')).build
    const debug = JSON.parse(readFileSync('eris-dev-builder.json', 'utf8'))
    expect(production.afterPack).toBe('scripts/check-packaged-secrets.cjs')
    expect(debug.afterPack).toBe('scripts/check-packaged-secrets.cjs')
    expect(JSON.stringify(production.extraResources)).toContain('!eris-feedback-token*')
    expect(JSON.stringify(debug.extraResources)).toContain('!eris-feedback-token*')
    expect(buildBugReportPreview(input).hasGithubToken).toBe(false)
  })
  it('returns retry guidance and never attempts direct GitHub fallback', async () => {
    const request = vi.fn(
      async (_url: string | URL | Request, _options?: RequestInit) =>
        new Response('{}', { status: 503 })
    )
    vi.stubGlobal('fetch', request)
    expect(await submitBugReport(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('retry')
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]?.[0])).not.toContain('api.github.com')
  })
  it('rejects foreign issue URLs and accepts only the intended issues repository', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ ok: true, htmlUrl: 'https://github.com/other/repo/issues/1' })
        )
    )
    expect(await submitBugReport(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('valid Eris issue')
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            htmlUrl: 'https://github.com/EricServices-Repo/Eris/issues/123',
            number: 123
          })
        )
    )
    expect(await submitBugReport(input)).toMatchObject({
      ok: true,
      number: 123,
      via: 'ericservices'
    })
  })
})
