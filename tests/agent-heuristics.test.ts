import { describe, expect, it } from 'vitest'
import {
  isUnfinishedWorkNarration,
  looksLikeTaskComplete,
  trailingMutationFailed
} from '../electron/main/services/agent/heuristics'

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

describe('unfinished review narration', () => {
  it.each([
    'I need to read more files to complete the review. Let me check calendar.php.',
    "I'll inspect the source before giving the findings.",
    'I’ll check the remaining files.',
    'Let me review the remaining source files.'
  ])('rejects a promise to continue: %s', (text) => {
    expect(isUnfinishedWorkNarration(text)).toBe(true)
  })
  it.each([
    '1. Add request validation in booking.php.\n2. Add tests for failed bookings.',
    'In booking.php, validate the date range before saving a booking.'
  ])('preserves a substantive finding: %s', (text) => {
    expect(isUnfinishedWorkNarration(text)).toBe(false)
  })
})

describe('implementation completion summaries', () => {
  it('accepts completed work presented as three numbered items', () => {
    expect(
      looksLikeTaskComplete(
        '1. Created the frontend.\n2. Implemented registration.\n3. Created the admin pages.'
      )
    ).toBe(true)
  })
  it('keeps a numbered implementation plan in the work loop', () => {
    expect(
      looksLikeTaskComplete(
        '1. Create the frontend.\n2. Implement registration.\n3. Create the admin pages.'
      )
    ).toBe(false)
  })
})
