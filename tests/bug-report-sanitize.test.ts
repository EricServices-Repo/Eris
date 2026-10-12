import { describe, expect, it } from 'vitest'
import { redactBugReportText } from '../src/shared/bug-report-sanitize'

describe('redactBugReportText', () => {
  it('redacts GitHub tokens', () => {
    const out = redactBugReportText('tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end')
    expect(out).toContain('[redacted-github-token]')
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('redacts authorization values and Bearer tokens', () => {
    expect(redactBugReportText('Authorization: secret-value-here')).toContain('Authorization=[redacted]')
    expect(redactBugReportText('Bearer abc.def.ghi')).toContain('Bearer [redacted]')
  })

  it('rewrites home directory paths', () => {
    expect(redactBugReportText('/Users/eric/Library/logs/eris.log', '/Users/eric')).toBe(
      '~/Library/logs/eris.log'
    )
  })
})
