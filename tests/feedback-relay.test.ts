import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('./mocks/electron')>('./mocks/electron')
  return { ...actual, app: { ...actual.app, getLocale: () => 'en-US' } }
})
vi.mock('../electron/main/ipc/shared', () => ({ getSecret: () => null }))
import {
  submitBugReport,
  buildBugReportPreview,
  listFeedbackHistory
} from '../electron/main/services/bug-report'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'eris-feedback-relay-'))
  vi.stubEnv('ERIS_TEST_APPDATA', directory)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
const input = {
  title: 'Synthetic regression',
  description: 'Fixture only',
  includeLogs: false,
  includeDiagnostics: false
}
describe('feedback stays on the relay boundary', () => {
  it('uses the bundled source identity even when optional diagnostics are disabled', () => {
    vi.stubGlobal('__ERIS_SOURCE_IDENTITY__', { gitSha: 'a'.repeat(40), dirty: true, lockSha256: 'x' })
    const preview = buildBugReportPreview(input)
    expect(preview.diagnostics).toMatchObject({ sourceCommit: 'a'.repeat(40), sourceDirty: true })
    expect(preview.body).toContain(`source ${'a'.repeat(40)}, dirty`)
    expect(preview.body).not.toContain('## Environment')
  })
  it('reports unknown source rather than consulting the working checkout', () => {
    vi.stubGlobal('__ERIS_SOURCE_IDENTITY__', { gitSha: 'invalid', dirty: null })
    const preview = buildBugReportPreview(input)
    expect(preview.body).toContain('source unknown, dirty state unknown')
  })
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
  it('rejects foreign issue URLs and accepts the requested product repository', async () => {
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

describe('product repository feedback routing', () => {
  it.each(['htmlUrl', 'html_url'])(
    'accepts the product repository using %s and records the actual issue',
    async (field) => {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              [field]: 'https://github.com/EricServices-Repo/Eris/issues/8'
            })
          )
      )
      vi.stubGlobal('fetch', request)
      expect(await submitBugReport(input)).toMatchObject({
        ok: true,
        number: 8,
        htmlUrl: 'https://github.com/EricServices-Repo/Eris/issues/8'
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(listFeedbackHistory()).toMatchObject([
        { number: 8, htmlUrl: 'https://github.com/EricServices-Repo/Eris/issues/8' }
      ])
    }
  )

  it('requests only the main repository and rejects a relay that files in the old inbox', async () => {
    const request = vi.fn(
      async (_url: string | URL | Request, _options?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            htmlUrl: 'https://github.com/EricServices-Repo/Eris-feedback/issues/8',
            number: 8
          })
        )
    )
    vi.stubGlobal('fetch', request)
    expect(buildBugReportPreview(input).targetRepo).toBe('EricServices-Repo/Eris')
    expect(await submitBugReport(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('EricServices-Repo/Eris')
    })
    expect(request).toHaveBeenCalledTimes(1)
    const options = request.mock.calls[0]?.[1] as RequestInit | undefined
    expect(JSON.parse(String(options?.body))).toMatchObject({
      owner: 'EricServices-Repo',
      repo: 'Eris'
    })
    expect(listFeedbackHistory()).toHaveLength(0)
  })

  it.each([
    'https://github.com/other/Eris-feedback/issues/8',
    'https://github.com/EricServices-Repo/Eris-feedback-evil/issues/8',
    'https://github.com.evil.test/EricServices-Repo/Eris/issues/8',
    'http://github.com/EricServices-Repo/Eris/issues/8',
    'https://user:pass@github.com/EricServices-Repo/Eris/issues/8',
    'https://github.com:444/EricServices-Repo/Eris/issues/8',
    'https://github.com/EricServices-Repo/Eris-feedback/pull/8',
    'https://github.com/EricServices-Repo/Eris/issues/8?redirect=elsewhere',
    'https://github.com/EricServices-Repo/Eris-feedback/issues/0',
    'https://github.com/EricServices-Repo/Eris-feedback/issues/9007199254740992'
  ])('rejects untrusted or malformed success URL %s', async (htmlUrl) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, htmlUrl })))
    expect(await submitBugReport(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('may already exist')
    })
    expect(listFeedbackHistory()).toHaveLength(0)
  })

  it('rejects conflicting issue numbers instead of recording an incorrect success', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            htmlUrl: 'https://github.com/EricServices-Repo/Eris/issues/8',
            number: 9
          })
        )
    )
    expect((await submitBugReport(input)).ok).toBe(false)
    expect(listFeedbackHistory()).toHaveLength(0)
  })
})
