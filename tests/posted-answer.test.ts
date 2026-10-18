import { describe, expect, it } from 'vitest'
import { promoteThinkingToAnswer, stripAnswerFromThinking } from '../src/shared/posted-answer'

describe('promoteThinkingToAnswer', () => {
  it('posts the thinking reply when the body is only the tool log', () => {
    const thinking =
      'This project is a calculator. src/main.ts adds numbers and src/App.tsx draws the keypad.'
    const content = 'Finished: Review this project\n\nWhat I did:\n• Inspected .'
    expect(promoteThinkingToAnswer(content, thinking)).toBe(thinking)
  })

  it('does not promote a tool log out of thinking', () => {
    const content = 'This project is a calculator in src/main.ts and the keypad is in src/App.tsx.'
    const thinking =
      'Finished: Review this project\n\nWhat I did:\n• Inspected .\n• Failed read_file steve-embling/.eris/rules/README.md'
    expect(promoteThinkingToAnswer(content, thinking)).toBe(content)
  })

  it('removes the reply from the thinking trace', () => {
    const answer = 'This project is a calculator in src/main.ts and the keypad is in src/App.tsx.'
    expect(stripAnswerFromThinking(answer, answer)).toBe('')
    expect(stripAnswerFromThinking(`Route: Auto\n\n${answer}`, answer)).toBe('Route: Auto')
    expect(stripAnswerFromThinking('This is the whole reply in a paragraph.', 'This is the whole reply in a paragraph.')).toBe('')
  })
})
