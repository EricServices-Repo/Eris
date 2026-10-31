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
/** Conservative serialized UTF-16 estimate, including nested traces, assets and tool metadata.
 * These are retained renderer objects, not only the strings painted by the virtual list. */
export const messageBytes = (message: ChatMessage) => JSON.stringify(message).length * 2 + 512
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
  let kept = messages.length
  let incoming = messages.reduce((sum, message) => sum + messageBytes(message), 0)
  while (kept > 1 && incoming > maxBytes) incoming -= messageBytes(messages[--kept]!)
  const pages = [pageOf(start, messages.slice(0, kept)), ...window.pages]
  // A shortened page is no longer adjacent to the old window.
  if (kept !== messages.length) pages.splice(1)
  let bytes = (kept === messages.length ? window.bytes : 0) + pages[0]!.bytes
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
  let dropped = 0
  let incoming = messages.reduce((sum, message) => sum + messageBytes(message), 0)
  while (messages.length - dropped > 1 && incoming > maxBytes)
    incoming -= messageBytes(messages[dropped++]!)
  const pages = [...(dropped ? [] : window.pages), pageOf(start + dropped, messages.slice(dropped))]
  let bytes = (dropped ? 0 : window.bytes) + pages[pages.length - 1]!.bytes
  while (pages.length > 1 && bytes > maxBytes) bytes -= pages.shift()!.bytes
  return { ...window, pages, bytes }
}
/** Replace the window with the one page holding a message, however far away it is. */
export const windowAt = (threadId: string, start: number, messages: ChatMessage[]): HistoryWindow =>
  addEarlierPage(emptyHistoryWindow(threadId), start, messages)
/** Page bounds that centre an ordinal without reading past the live tail. */
export function pageAround(ordinal: number, tailStart: number) {
  const before = Math.min(ordinal + HISTORY_PAGE_MESSAGES / 2, tailStart)
  return { before, limit: HISTORY_PAGE_MESSAGES }
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
  while (bytes > maxBytes && thread.messages.length - dropped > 1)
    bytes -= messageBytes(thread.messages[dropped++]!)
  if (!dropped) return thread
  return {
    ...thread,
    messages: thread.messages.slice(dropped),
    messageOffset: (thread.messageOffset ?? 0) + dropped
  }
}
