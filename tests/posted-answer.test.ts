import { finalizePostedAnswer, modelHistoryContent, upsertTerminalReply, visibleOutcomeAssessment } from '../src/shared/posted-answer'
import type { ChatMessage, ChatThread } from '../src/shared/settings-schema'
import { describe, expect, it } from 'vitest'
import { promoteThinkingToAnswer, stripAnswerFromThinking } from '../src/shared/posted-answer'

describe('failed terminal reply reconciliation (#449)', () => {
  it('preserves paged history and replaces duplicate request snapshots with their evidence', () => {
    const user: ChatMessage={id:'user',role:'user',content:'Fix booking',createdAt:1}
    const thread: ChatThread={id:'thread',title:'Booking',model:'local:test',createdAt:1,updatedAt:1,
      messages:[user],messageOffset:20,messageCount:21}
    const partial: ChatMessage={id:'request:assistant',role:'assistant',content:'Partial booking implementation',createdAt:2,
      contextResult:{taskId:'request',terminal:'failed',projectRoot:null,changedFiles:['booking.ts']}}
    const once=upsertTerminalReply(thread,partial)
    const twice=upsertTerminalReply(once,{...partial,content:'Partial booking implementation. Failed.'})
    expect(twice.messages).toHaveLength(2)
    expect(twice.messages[0]).toEqual(user)
    expect(twice.messages[1]?.contextResult?.changedFiles).toEqual(['booking.ts'])
    expect(twice.messageOffset).toBe(20)
    expect(twice.messageCount).toBe(22)
  })
})

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

describe('host notes in model history (#502)', () => {
  it('drops outcome verdicts and status notes but keeps what the model said', () => {
    const stored =
      'Added the button to todo.html.\n\nOutcome check: unresolved. Semantic assessment timed out; this does not establish whether the implementation succeeded.'
    expect(modelHistoryContent(stored)).toBe('Added the button to todo.html.')
    expect(modelHistoryContent('Partial work.\n\nPartial response: the request failed before completion. Applied changes: a.ts.'))
      .toBe('Partial work.')
    expect(modelHistoryContent('Draft.\n\nStopped. Applied changes: a.ts. Remaining work may be incomplete.')).toBe('Draft.')
    expect(modelHistoryContent('Some text\n\n_(stopped)_')).toBe('Some text')
    expect(modelHistoryContent('Done.\n\nTask result could not be saved. Applied changes are preserved.')).toBe('Done.')
  })
  it('keeps prose that merely mentions an outcome check', () => {
    const text = 'The outcome check in task-outcome.ts uses a 15 second deadline.'
    expect(modelHistoryContent(text)).toBe(text)
  })
})

describe('visible outcome assessment (#500, #502)', () => {
  it('shows a real finding and hides a reviewer that did not run', () => {
    expect(visibleOutcomeAssessment({ status: 'partial', reason: 'Missing date check.' }))
      .toEqual({ label: 'Outcome check: partial', reason: 'Missing date check.' })
    expect(visibleOutcomeAssessment({ status: 'unresolved', failure: 'timeout', reason: 'timed out' })).toBeNull()
    expect(visibleOutcomeAssessment({ status: 'unresolved', failure: 'reference-unavailable', reason: 'gone' }))
      .toEqual({ label: 'Outcome check: unresolved', reason: 'gone' })
    expect(visibleOutcomeAssessment({ status: 'supported' })).toBeNull()
    expect(visibleOutcomeAssessment({ status: 'not-run' })).toBeNull()
    expect(visibleOutcomeAssessment(undefined)).toBeNull()
  })
})
