import { describe, expect, it } from 'vitest'
import { messagesToLlamaHistory, splitSessionPrompt } from '../src/shared/llama-session'

describe('splitSessionPrompt', () => {
  it('splits seed history from the trailing user turn', () => {
    const split = splitSessionPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: 'tool call' },
      { role: 'user', content: 'TOOL_RESULT' }
    ])
    expect(split).toEqual({
      seed: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: 'tool call' }
      ],
      userMessage: 'TOOL_RESULT'
    })
  })

  it('returns null when there is no user message', () => {
    expect(splitSessionPrompt([{ role: 'system', content: 'sys' }])).toBeNull()
  })

  it('seeds empty when the only message is the user turn', () => {
    expect(splitSessionPrompt([{ role: 'user', content: 'hi' }])).toEqual({
      seed: [],
      userMessage: 'hi'
    })
  })
})

describe('messagesToLlamaHistory', () => {
  it('maps roles to node-llama-cpp history entries', () => {
    expect(
      messagesToLlamaHistory([
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' }
      ])
    ).toEqual([
      { type: 'system', text: 's' },
      { type: 'user', text: 'u' },
      { type: 'model', response: ['a'] }
    ])
  })
})
