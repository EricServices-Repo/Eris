import { describe, expect, it } from 'vitest'
import {
  actionLogHasBuildSuccess,
  assessGoalCompletion,
  goalWantsPackagedApp,
  trailingMutationFailed
} from '../electron/main/services/agent/heuristics'

describe('goalWantsPackagedApp', () => {
  it('detects .app / macos packaging goals', () => {
    expect(goalWantsPackagedApp('build calculator.app')).toBe(true)
    expect(goalWantsPackagedApp('Ship a macOS app with electron-builder')).toBe(true)
    expect(goalWantsPackagedApp('fix the button color')).toBe(false)
  })
})

describe('trailingMutationFailed', () => {
  it('is true when the last mutation failed', () => {
    expect(
      trailingMutationFailed([
        'Inspected .',
        'Failed search_replace calculator-react/src/App.js: old_string not found'
      ])
    ).toBe(true)
  })

  it('is false when a write recovers after a failure', () => {
    expect(
      trailingMutationFailed([
        'Failed search_replace App.js: old_string not found',
        'Wrote calculator-react/src/Calculator.js'
      ])
    ).toBe(false)
  })
})

describe('assessGoalCompletion', () => {
  it('rejects DONE after a failed edit with no recovery', () => {
    const r = assessGoalCompletion({
      goal: 'fix App.js',
      assistantText: 'Finished: fixed App.js',
      actionLog: ['Failed search_replace App.js: old_string not found'],
      filesTouched: [],
      codeMutated: false,
      reviewOnly: false
    })
    expect(r.unmet).toBe(true)
    expect(r.reason).toMatch(/failed/i)
  })

  it('rejects DONE for .app goals that only wrote tiny stubs', () => {
    const r = assessGoalCompletion({
      goal: 'build calculator.app',
      assistantText: 'Finished: build calculator.app\n\nWhat I did:\n• Created Calculator.js',
      actionLog: [
        'Inspected .',
        'Failed search_replace calculator-react/src/App.js: old_string not found',
        'Wrote calculator-react/src/Calculator.js'
      ],
      filesTouched: ['calculator-react/src/Calculator.js'],
      codeMutated: true,
      reviewOnly: false,
      onlyTinyStubs: true
    })
    expect(r.unmet).toBe(true)
    expect(r.reason).toMatch(/\.app|stub|packaged/i)
  })

  it('accepts DONE when a real build succeeded', () => {
    expect(actionLogHasBuildSuccess(['Verify passed: npm run build'])).toBe(true)
    const r = assessGoalCompletion({
      goal: 'build calculator.app',
      assistantText: 'Finished: packaged the app',
      actionLog: ['Wrote src/main.ts', 'npm run dist:mac ok', 'Created dist/mac-arm64/Calculator.app'],
      filesTouched: ['src/main.ts', 'dist/mac-arm64/Calculator.app'],
      codeMutated: true,
      reviewOnly: false,
      onlyTinyStubs: false,
      verifyPassed: true
    })
    expect(r.unmet).toBe(false)
  })

  it('does not block review-only goals', () => {
    const r = assessGoalCompletion({
      goal: 'review the calculator',
      assistantText: 'Findings: looks fine',
      actionLog: ['Read App.js'],
      filesTouched: [],
      codeMutated: false,
      reviewOnly: true
    })
    expect(r.unmet).toBe(false)
  })
})
