import { describe, expect, it } from 'vitest'
import { promoteThinkingToAnswer } from '../src/shared/posted-answer'

describe('promoteThinkingToAnswer', () => {
  it('posts the thinking reply when the body is only the tool log', () => {
    const thinking =
      'This project is a calculator. src/main.ts adds numbers and src/App.tsx draws the keypad.'
    const content = 'Finished: Review this project\n\nWhat I did:\n• Inspected .'
    expect(promoteThinkingToAnswer(content, thinking)).toBe(thinking)
  })

  it('keeps a real answer that is already outside thinking', () => {
    const content = 'This project is a calculator in src/main.ts and the keypad is in src/App.tsx.'
    expect(promoteThinkingToAnswer(content, '— Read README.md')).toBe(content)
  })
})
