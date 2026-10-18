import { describe, expect, it } from 'vitest'
import { trailingMutationFailed } from '../electron/main/services/agent/heuristics'

describe('agent completion heuristics', () => {
  it('reports an unresolved failed mutation', () => {
    expect(
      trailingMutationFailed([
        'Read src/app.ts',
        'Failed search_replace src/app.ts: old_string was not found'
      ])
    ).toBe(true)
  })

  it('clears a failed mutation after a successful edit', () => {
    expect(
      trailingMutationFailed([
        'Failed search_replace src/app.ts: old_string was not found',
        'Replaced 1 occurrence(s) in src/app.ts'
      ])
    ).toBe(false)
  })

  it('does not classify command or read failures as failed mutations', () => {
    expect(
      trailingMutationFailed([
        'Failed run node dangerous-check.js: The user denied running it',
        'Failed read_file missing.ts: file not found',
        'Replaced 1 occurrence(s) in src/app.ts'
      ])
    ).toBe(false)
  })
})
