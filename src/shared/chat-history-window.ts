import type { ChatMessage, ChatThread } from './settings-schema'

/** Older pages kept for browsing. They are copies: SQLite remains the transcript. */
export const HISTORY_WINDOW_BYTES = 8 * 1024 ** 2
/** Recent messages kept in the live thread, which later saves write back. */
export const TAIL_BYTES = 8 * 1024 ** 2
export const HISTORY_PAGE_MESSAGES = 60

export type HistoryPage = { start: number; messages: ChatMessage[]; bytes: number }
/** Contiguous older pages, separate from the live tail so a save can never truncate them. */
export type HistoryWindow = { threadId: string | null; pages: HistoryPage[]; bytes: number }

export const emptyHistoryWindow = (threadId: string | null = null): HistoryWindow => ({
  threadId,
  pages: [],
  bytes: 0
})
/** UTF-16 storage of the retained strings; a stable estimate, not a heap measurement. */
export const messageBytes = (message: ChatMessage) =>
  (message.content.length + (message.thinking?.length ?? 0)) * 2 +
  (message.assets?.length ?? 0) * 256 +
  512
const pageOf = (start: number, messages: ChatMessage[]): HistoryPage => ({
  start,
  messages,
  bytes: messages.reduce((sum, message) => sum + messageBytes(message), 0)
})
export const windowStart = (window: HistoryWindow) => window.pages[0]?.start
export function windowEnd(window: HistoryWindow) {
  const last = window.pages[window.pages.length - 1]
  return last && last.start + last.messages.length
}
/** Add a page before the window, evicting the pages furthest from the reader. */
export function addEarlierPage(
  window: HistoryWindow,
  start: number,
  messages: ChatMessage[],
  maxBytes = HISTORY_WINDOW_BYTES
): HistoryWindow {
  const pages = [pageOf(start, messages), ...window.pages]
  let bytes = window.bytes + pages[0]!.bytes
  while (pages.length > 1 && bytes > maxBytes) bytes -= pages.pop()!.bytes
  return { ...window, pages, bytes }
}
/** Add a page after the window, evicting the pages furthest from the reader. */
export function addLaterPage(
  window: HistoryWindow,
  start: number,
  messages: ChatMessage[],
  maxBytes = HISTORY_WINDOW_BYTES
): HistoryWindow {
  const pages = [...window.pages, pageOf(start, messages)]
  let bytes = window.bytes + pages[pages.length - 1]!.bytes
  while (pages.length > 1 && bytes > maxBytes) bytes -= pages.shift()!.bytes
  return { ...window, pages, bytes }
}
/**
 * What the transcript should show. The live tail is omitted while evicted pages
 * separate it from the window, so a gap is never presented as adjacent messages.
 */
export function historyView(window: HistoryWindow, tail: ChatThread | null | undefined) {
  const tailStart = tail?.messageOffset ?? 0
  const tailMessages = tail?.messages ?? []
  const end = windowEnd(window)
  const gap = end !== undefined && end < tailStart
  const older = window.pages.flatMap((page) =>
    page.messages.slice(0, Math.max(0, tailStart - page.start))
  )
  return {
    messages: gap ? older : older.length ? [...older, ...tailMessages] : tailMessages,
    start: windowStart(window) ?? tailStart,
    gap,
    bytes: window.bytes + tailMessages.reduce((sum, message) => sum + messageBytes(message), 0)
  }
}
/** Keep long sessions bounded by advancing the offset; dropped rows reload as earlier pages. */
export function boundTail(thread: ChatThread, maxBytes = TAIL_BYTES): ChatThread {
  let bytes = thread.messages.reduce((sum, message) => sum + messageBytes(message), 0)
  let dropped = 0
  while (bytes > maxBytes && thread.messages.length - dropped > HISTORY_PAGE_MESSAGES)
    bytes -= messageBytes(thread.messages[dropped++]!)
  if (!dropped) return thread
  return {
    ...thread,
    messages: thread.messages.slice(dropped),
    messageOffset: (thread.messageOffset ?? 0) + dropped
  }
}
