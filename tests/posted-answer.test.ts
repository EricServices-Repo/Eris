import { finalizePostedAnswer } from '../src/shared/posted-answer'
import { describe, expect, it } from 'vitest'
import { promoteThinkingToAnswer, stripAnswerFromThinking } from '../src/shared/posted-answer'

describe('promoteThinkingToAnswer', () => {
  const routing =
    'Route: Auto → Composer · edit · local:qwen25-coder-7b\nPlan: Inspect affected code and project rules → Make the requested changes → Run relevant verification → Summarize the diff.'
  it.each(['Could not identify the requested project.', 'No agents configured', 'Done.'])(
    'keeps an explicit answer even when routing text is longer: %s',
    (answer) => {
      expect(promoteThinkingToAnswer(answer, routing)).toBe(answer)
    }
  )
  it('does not present routing or a plan preamble as a missing answer', () => {
    expect(promoteThinkingToAnswer('', routing)).toBe('')
  })

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
    expect(
      stripAnswerFromThinking(
        'This is the whole reply in a paragraph.',
        'This is the whole reply in a paragraph.'
      )
    ).toBe('')
  })
})

it('finalizes identical durable and visible replies for image-only, stopped and empty turns', () => {
  expect(finalizePostedAnswer('', '', false, true)).toEqual({ content: '', thinking: '' })
  expect(finalizePostedAnswer('Partial answer', '— Step', true, false)).toEqual({
    content: 'Partial answer\n\n_(stopped)_',
    thinking: '— Step'
  })
  expect(finalizePostedAnswer('', '', false, false).content).toContain('ended without a response')
})
