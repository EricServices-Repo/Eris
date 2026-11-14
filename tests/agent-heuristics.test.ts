import { describe, expect, it } from 'vitest'
import {
  isUnfinishedWorkNarration,
  looksLikeTaskComplete,
  shouldKeepWorking,
  trailingMutationFailed,
  unresolvedMutationFailures,
  withoutClosingOffer
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

describe('completion replies after a change (#499)', () => {
  it.each([
    'I have added a "Clear all" button to todo.html and a clearAllTasks() handler in todo.js. Let me know if you need any further changes.',
    'The Clear all button has been added to todo.html. Is there anything else you would like me to do?',
    'DONE. Created todo.html, todo.css and todo.js.',
    'Added the footer to hello.html.',
    'The changes are complete. I used read_file to inspect todo.html and search_replace to add the button.',
    'Summary of changes:\n1. Added a button to todo.html\n2. Added clearAllTasks to todo.js\n3. Wired the onclick\n4. Kept the styles\n5. Done'
  ])('accepts a finished recap: %s', (text) => {
    expect(looksLikeTaskComplete(text)).toBe(true)
    expect(shouldKeepWorking({ needsTools: true, mutated: true, assistantText: text, actions: ['Replaced 1 occurrence(s) in todo.html'] })).toBe(false)
  })
  it.each([
    'Next, I will add the CSS.',
    'Let me now update todo.js.',
    'I will use read_file to check todo.js.',
    'Added the button. TODO: wire the handler.',
    'The button is not done yet.',
    '1. Create the page.\n2. Add the list.\n3. Add the button.\n4. Style it.\n5. Test it.'
  ])('keeps unfinished work in the loop: %s', (text) => {
    expect(shouldKeepWorking({ needsTools: true, mutated: true, assistantText: text, actions: ['Replaced 1 occurrence(s) in todo.html'] })).toBe(true)
  })
  it('treats only the uppercase marker as TODO, not a todo.* file or a to-do list', () => {
    expect(looksLikeTaskComplete('Updated todo.js so the todo list clears.')).toBe(true)
    expect(looksLikeTaskComplete('Updated app.js. TODO: add tests.')).toBe(false)
  })
  it('strips closing offers but keeps real questions open', () => {
    expect(withoutClosingOffer('Added the button. Let me know if you need anything else.')).toBe('Added the button.')
    expect(looksLikeTaskComplete('Should I put the handler in todo.js or app.js?')).toBe(false)
  })
})

describe('failed follow-up edits (#499)', () => {
  it('calls a failure on an already-changed file a refinement', () => {
    expect(unresolvedMutationFailures([
      'Created todo.html (447 bytes)',
      'Read todo.html',
      'Failed search_replace todo.html: old_string not found in todo.html'
    ])).toEqual([{ path: 'todo.html', refinement: true }])
  })
  it('does not call a failure on an untouched file a refinement', () => {
    expect(unresolvedMutationFailures([
      'Created todo.js (10 bytes)',
      'Failed search_replace todo.html: old_string not found'
    ])).toEqual([{ path: 'todo.html', refinement: false }])
  })
  it('clears a failure that a later edit to the same file fixed', () => {
    expect(unresolvedMutationFailures([
      'Failed search_replace a.ts: old_string not found',
      'Replaced 1 occurrence(s) in a.ts'
    ])).toEqual([])
  })
  it('keeps an unnamed failure unresolved and not a refinement', () => {
    expect(unresolvedMutationFailures(['Created a.ts (1 bytes)', 'Failed write_file: path is required']))
      .toEqual([{ path: null, refinement: false }])
  })
})

describe('run turns that report a command (#503)', () => {
  const base = { needsTools: true, mutated: false, commandReported: true, actions: ['Ran ls -la'] }
  it('finishes when the reply reports the output', () => {
    expect(shouldKeepWorking({ ...base, assistantText: 'I ran `ls -la`: the folder has 3 files.' })).toBe(false)
  })
  it('keeps going when the reply promises more tool work', () => {
    expect(shouldKeepWorking({ ...base, assistantText: "I'll run it again with -R to include subfolders." })).toBe(true)
    expect(shouldKeepWorking({ ...base, assistantText: 'Let me check the output first, then summarize.' })).toBe(true)
  })
  it('keeps going on an empty or tiny reply', () => {
    expect(shouldKeepWorking({ ...base, assistantText: 'Done.' })).toBe(true)
  })
  it('still requires a mutation when no command was run', () => {
    expect(shouldKeepWorking({ ...base, commandReported: false, assistantText: 'The folder has 3 files.' })).toBe(true)
  })
})

describe('replies that end by announcing the next action (#506)', () => {
  it.each([
    'I created hello.html. Next, I will run a cat command to verify.',
    'The page is written. Let me verify by running cat hello.html.',
    "Done with the edit. I'll run the tests now."
  ])('treats %j as unfinished', (text) => {
    expect(isUnfinishedWorkNarration(text)).toBe(true)
  })
  it.each([
    'I ran `cat hello.html` and the heading is present.',
    'Let me know if you want a different color.',
    'I will run through the remaining steps with you whenever you are ready.'
  ])('does not flag %j', (text) => {
    expect(isUnfinishedWorkNarration(text)).toBe(false)
  })
})

import { nativeParameterBillions } from '../electron/main/services/agent/heuristics'
it('uses only known native model parameter counts for first-step constraints', () => {
  expect(nativeParameterBillions('builtin:composer-lite')).toBe(1.5)
  expect(nativeParameterBillions('builtin:composer')).toBe(7)
  expect(nativeParameterBillions('builtin:missing')).toBe(Infinity)
})
