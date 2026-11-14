import { describe, expect, it } from 'vitest'
import {
  createReasoningSplitter,
  splitLeadingReasoning
} from '../electron/main/services/reasoning-split'

/** #573: inline `<think>` reasoning is separated from the answer. */
function run(chunks: string[]) {
  const splitter = createReasoningSplitter()
  let answer = ''
  let reasoning = ''
  for (const chunk of chunks) {
    const part = splitter.push(chunk)
    answer += part.answer
    reasoning += part.reasoning
  }
  const end = splitter.flush()
  return { answer: answer + end.answer, reasoning: reasoning + end.reasoning }
}

describe('createReasoningSplitter', () => {
  it('passes a plain answer through unchanged', () => {
    expect(run(['Hello ', 'world.'])).toEqual({ answer: 'Hello world.', reasoning: '' })
  })

  it('does not hold a plain answer that cannot become an opening tag', () => {
    const splitter = createReasoningSplitter()
    expect(splitter.push('Sure').answer).toBe('Sure')
  })

  it('separates a leading think block', () => {
    expect(run(['<think>plan it</think>The answer.'])).toEqual({
      answer: 'The answer.',
      reasoning: 'plan it'
    })
  })

  it('handles tags split across chunks', () => {
    const out = run(['  <thi', 'nk>step one', ' step two</th', 'ink>', 'Done.'])
    expect(out.reasoning).toBe('step one step two')
    expect(out.answer).toBe('Done.')
  })

  it('accepts <thinking> tags', () => {
    expect(run(['<thinking>x</thinking>y'])).toEqual({ answer: 'y', reasoning: 'x' })
  })

  it('treats a think tag later in the answer as answer text', () => {
    const text = 'Use `<think>` tags like this: <think>a</think>'
    expect(run([text])).toEqual({ answer: text, reasoning: '' })
  })

  it('treats an unclosed block as all reasoning', () => {
    expect(run(['<think>still going'])).toEqual({ answer: '', reasoning: 'still going' })
  })

  it('releases a lone "<" that never became a tag', () => {
    expect(run(['<', 'b>bold'])).toEqual({ answer: '<b>bold', reasoning: '' })
  })
})

describe('splitLeadingReasoning', () => {
  it('splits a bare closing tag whose opener was in the prompt', () => {
    expect(splitLeadingReasoning('thinking here\n</think>\n\nAnswer.')).toEqual({
      reasoning: 'thinking here',
      answer: 'Answer.'
    })
  })

  it('leaves text without a closer alone', () => {
    expect(splitLeadingReasoning('Just an answer.')).toBeNull()
  })

  it('leaves a closer inside a code sample alone', () => {
    expect(splitLeadingReasoning('```html\n</think>\n```')).toBeNull()
  })
})
