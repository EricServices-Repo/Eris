import { describe, expect, it } from 'vitest'
import { redactBugReportText } from '../src/shared/bug-report-sanitize'

describe('redactBugReportText', () => {
  it('redacts GitHub tokens', () => {
    const out = redactBugReportText('tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end')
    expect(out).toContain('[redacted-github-token]')
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('redacts authorization values and Bearer tokens', () => {
    expect(redactBugReportText('Authorization: secret-value-here')).toContain(
      'Authorization=[redacted]'
    )
    expect(redactBugReportText('Bearer abc.def.ghi')).toContain('Bearer [redacted]')
  })

  it('rewrites home directory paths', () => {
    expect(redactBugReportText('/Users/eric/Library/logs/eris.log', '/Users/eric')).toBe(
      '~/Library/logs/eris.log'
    )
  })
})

describe('redactBugReportText provider and structured secrets', () => {
  it('redacts the credential after an auth scheme, not just the scheme word', () => {
    const out = redactBugReportText('Authorization: Bearer abc123def456ghi')
    expect(out).toBe('Authorization=[redacted]')
    expect(redactBugReportText('authorization=Basic dXNlcjpwYXNz')).toBe('authorization=[redacted]')
  })

  it.each([
    'sk-proj-AbCdEf_GhIjKlMnOpQrStUv',
    'sk-ant-api03-abcdefghijklmnopqrstu',
    'sk-or-v1-abcdefghijklmnopqrstuvwx',
    'hf_abcdefghijklmnopqrstuvwxyz123456',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij'
  ])('redacts bare provider credential %s', (secret) => {
    const out = redactBugReportText(`failed with ${secret} today`)
    expect(out).not.toContain(secret)
    expect(out).toMatch(/^failed with \[redacted-[a-z-]+\] today$/)
  })

  it('redacts quoted JSON fields and keeps the JSON parseable', () => {
    const json = JSON.stringify({ apiKey: 'zzz', password: 'hunter2', token: 't0k', model: 'gpt' })
    const out = redactBugReportText(json)
    expect(JSON.parse(out)).toEqual({
      apiKey: '[redacted]',
      password: '[redacted]',
      token: '[redacted]',
      model: 'gpt'
    })
  })

  it('leaves ordinary prose and token counts alone', () => {
    for (const text of [
      'the token expired yesterday',
      'max_tokens: 4096',
      '"inputTokens": 120',
      'Basic setup works'
    ])
      expect(redactBugReportText(text)).toBe(text)
  })
})
