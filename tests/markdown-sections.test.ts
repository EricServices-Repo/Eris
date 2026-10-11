import { describe, expect, it } from 'vitest'
import { upsertEmailSection } from '../electron/main/services/email-context'

describe('upsertEmailSection', () => {
  it('replaces a trailing section completely, even when it contains "Z"', () => {
    const body = '# Context\n\n## Email\nZebra report from Zoe\nold line\n'
    const next = upsertEmailSection(body, 'fresh digest')
    expect(next).toContain('## Email\nfresh digest\n')
    expect(next).not.toContain('Zebra')
    expect(next).not.toContain('old line')
  })

  it('keeps sections that follow the replaced one', () => {
    const body = '# C\n\n## Email\nold\n\n## Notes\nkeep me\n'
    const next = upsertEmailSection(body, 'new')
    expect(next).toBe('# C\n\n## Email\nnew\n\n## Notes\nkeep me\n')
  })

  it('appends the section when missing', () => {
    expect(upsertEmailSection('# C\n', 'd')).toBe('# C\n\n## Email\nd\n')
  })
})
