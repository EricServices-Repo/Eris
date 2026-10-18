import type { ChatThread } from './settings-schema'

/** Merge a freshly returned tail page without discarding history already loaded in the UI. */
export function mergeChatTail(current: ChatThread, tail: ChatThread): ChatThread {
  if (current.id !== tail.id) return tail
  const currentStart = current.messageOffset ?? 0
  const tailStart = tail.messageOffset ?? 0
  const currentEnd = currentStart + current.messages.length
  const tailEnd = tailStart + tail.messages.length

  // The pages should overlap or touch. If they do not, the server page is the
  // only ordering information we can trust.
  if (currentEnd < tailStart || tailEnd < currentStart) return tail

  const start = Math.min(currentStart, tailStart)
  const end = Math.max(currentEnd, tailEnd)
  const messages = new Array<ChatThread['messages'][number] | undefined>(end - start)
  current.messages.forEach((message, index) => {
    messages[currentStart + index - start] = message
  })
  tail.messages.forEach((message, index) => {
    messages[tailStart + index - start] = message
  })
  if (messages.some((message) => message === undefined)) return tail

  return {
    ...tail,
    messageOffset: start,
    messageCount: tail.messageCount ?? tailEnd,
    messages: messages as ChatThread['messages']
  }
}
