import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatThread } from '../src/shared/settings-schema'
import { mergeChatTail } from '../src/shared/chat-pages'

const message = (id: number): ChatMessage => ({
  id: String(id),
  role: id % 2 ? 'user' : 'assistant',
  content: String(id),
  createdAt: id
})

const thread = (offset: number, ids: number[], count: number): ChatThread => ({
  id: 'thread',
  title: 'Thread',
  model: 'model',
  createdAt: 1,
  updatedAt: 2,
  messageOffset: offset,
  messageCount: count,
  messages: ids.map(message)
})

describe('mergeChatTail', () => {
  it('keeps previously loaded history when an append returns only the latest page', () => {
    const loaded = thread(
      0,
      Array.from({ length: 120 }, (_, index) => index),
      120
    )
    const tail = thread(
      61,
      Array.from({ length: 60 }, (_, index) => index + 61),
      121
    )
    const merged = mergeChatTail(loaded, tail)
    expect(merged.messageOffset).toBe(0)
    expect(merged.messageCount).toBe(121)
    expect(merged.messages).toHaveLength(121)
    expect(merged.messages.at(-1)?.id).toBe('120')
  })

  it('falls back to the authoritative tail when pages have a gap', () => {
    const tail = thread(100, [100, 101], 102)
    expect(mergeChatTail(thread(0, [0, 1], 2), tail)).toBe(tail)
  })
})
