import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addEarlierPage,
  addLaterPage,
  boundTail,
  emptyHistoryWindow,
  historyView,
  HISTORY_PAGE_MESSAGES,
  messageBytes,
  TAIL_BYTES,
  windowEnd,
  windowStart,
  type HistoryWindow
} from '../src/shared/chat-history-window'
import { searchLoadedHistory } from '../src/shared/chat-history-search'
import { ChatDatabase } from '../electron/main/services/chat-database'
import type { ChatMessage, ChatThread } from '../src/shared/settings-schema'

const TOTAL = 6000
const message = (ordinal: number, chars = 2000): ChatMessage => ({
  id: `m${ordinal}`,
  role: ordinal % 2 ? 'assistant' : 'user',
  content: `Message ${ordinal} `.padEnd(chars, 'x'),
  createdAt: ordinal
})
/** Stand-in for chats:get: the page of canonical rows ending before `before`. */
const page = (before: number, limit = HISTORY_PAGE_MESSAGES) => {
  const start = Math.max(0, before - limit)
  return {
    start,
    messages: Array.from({ length: before - start }, (_, i) => message(start + i))
  }
}
const tail = (offset = TOTAL - HISTORY_PAGE_MESSAGES): ChatThread => ({
  id: 't',
  title: 'Long',
  model: 'local:test',
  createdAt: 1,
  updatedAt: 1,
  messageOffset: offset,
  messageCount: TOTAL,
  messages: Array.from({ length: TOTAL - offset }, (_, i) => message(offset + i))
})
const loadEarlier = (window: HistoryWindow, thread: ChatThread, maxBytes?: number) => {
  const { start, messages } = page(windowStart(window) ?? thread.messageOffset!)
  return addEarlierPage(window, start, messages, maxBytes)
}
const loadNewer = (window: HistoryWindow, thread: ChatThread, maxBytes?: number) => {
  const end = windowEnd(window)!
  const limit = Math.min(HISTORY_PAGE_MESSAGES, thread.messageOffset! - end)
  return addLaterPage(window, end, page(end + limit, limit).messages, maxBytes)
}
const ordinals = (messages: ChatMessage[]) => messages.map((m) => Number(m.id.slice(1)))
const contiguous = (values: number[]) => values.every((v, i) => !i || v === values[i - 1]! + 1)

describe('history window', () => {
  it('keeps a stable envelope while browsing the whole conversation', () => {
    const thread = tail()
    let window = emptyHistoryWindow('t')
    let peak = 0
    while ((windowStart(window) ?? 1) > 0) {
      window = loadEarlier(window, thread)
      peak = Math.max(peak, window.bytes)
    }
    expect(windowStart(window)).toBe(0)
    expect(peak).toBeLessThanOrEqual(8 * 1024 ** 2)
    expect(window.bytes).toBe(
      window.pages.flatMap((p) => p.messages).reduce((n, m) => n + messageBytes(m), 0)
    )
    expect(window.pages.length).toBeLessThan(TOTAL / HISTORY_PAGE_MESSAGES)
  })
  it('reloads evicted pages with no lost or duplicated messages', () => {
    const thread = tail()
    const small = 300 * 1024
    let window = emptyHistoryWindow('t')
    for (let i = 0; i < 12; i++) window = loadEarlier(window, thread, small)
    expect(historyView(window, thread).gap).toBe(true)
    const seen: number[] = []
    while (historyView(window, thread).gap) {
      seen.push(...ordinals(window.pages.at(-1)!.messages))
      window = loadNewer(window, thread, small)
      const shown = ordinals(historyView(window, thread).messages)
      expect(new Set(shown).size).toBe(shown.length)
      expect(contiguous(shown)).toBe(true)
    }
    const shown = ordinals(historyView(window, thread).messages)
    expect(shown.at(-1)).toBe(TOTAL - 1)
    expect(contiguous(shown)).toBe(true)
  })
  it('never presents messages across an eviction gap as adjacent', () => {
    const thread = tail()
    let window = emptyHistoryWindow('t')
    for (let i = 0; i < 8; i++) window = loadEarlier(window, thread, 200 * 1024)
    const view = historyView(window, thread)
    expect(view.gap).toBe(true)
    expect(ordinals(view.messages)).not.toContain(TOTAL - 1)
    expect(contiguous(ordinals(view.messages))).toBe(true)
  })
  it('joins the tail when the window touches it', () => {
    const thread = tail()
    const view = historyView(loadEarlier(emptyHistoryWindow('t'), thread), thread)
    expect(view.gap).toBe(false)
    expect(view.start).toBe(TOTAL - 120)
    expect(ordinals(view.messages)).toEqual(Array.from({ length: 120 }, (_, i) => TOTAL - 120 + i))
  })
  it('does not repeat a page the tail has grown over', () => {
    const thread = tail()
    const window = loadEarlier(emptyHistoryWindow('t'), thread)
    const grown = { ...tail(thread.messageOffset! - 10) }
    const shown = ordinals(historyView(window, grown).messages)
    expect(new Set(shown).size).toBe(shown.length)
  })
  it('keeps one oversized page rather than losing the reader', () => {
    const huge = [message(1, 2_000_000)]
    const window = addEarlierPage(emptyHistoryWindow('t'), 1, huge, 1024)
    expect(window.pages).toHaveLength(1)
    expect(addEarlierPage(window, 0, [message(0, 10)], 1024).pages[0]!.start).toBe(0)
  })
  it('separates renderer pages from the tail it reports', () => {
    const thread = tail()
    const window = loadEarlier(emptyHistoryWindow('t'), thread)
    const tailBytes = thread.messages.reduce((n, m) => n + messageBytes(m), 0)
    expect(historyView(window, thread).bytes).toBe(window.bytes + tailBytes)
  })
  it('searches only what is resident', async () => {
    const thread = tail()
    let window = emptyHistoryWindow('t')
    for (let i = 0; i < 8; i++) window = loadEarlier(window, thread, 200 * 1024)
    const { messages } = historyView(window, thread)
    const inside = messages[0]!
    expect(await searchLoadedHistory(messages, `Message ${inside.createdAt} `)).toEqual([inside.id])
    expect(await searchLoadedHistory(messages, `Message ${TOTAL - 1} `)).toEqual([])
  })
})

describe('live tail', () => {
  it('advances its offset to stay within budget in a long session', () => {
    const thread = tail(0)
    const bounded = boundTail(thread, 300 * 1024)
    expect(bounded.messages.length).toBeLessThan(thread.messages.length)
    expect(bounded.messageOffset).toBe(thread.messages.length - bounded.messages.length)
    expect(bounded.messages.at(-1)).toBe(thread.messages.at(-1))
  })
  it('keeps at least a page of recent messages', () => {
    expect(boundTail(tail(0), 1).messages).toHaveLength(HISTORY_PAGE_MESSAGES)
  })
  it('leaves a thread under budget untouched', () => {
    const thread = tail()
    expect(boundTail(thread, TAIL_BYTES)).toBe(thread)
  })
  it('cannot lose canonical rows when a bounded tail is saved', () => {
    const folder = mkdtempSync(join(tmpdir(), 'eris-history-'))
    const db = new ChatDatabase(folder)
    const rows = Array.from({ length: 200 }, (_, i) => message(i, 100))
    db.save({ ...tail(0), messages: rows, messageOffset: 0, messageCount: 200 })
    const loaded = db.get('t', { limit: 200 })!
    const bounded = boundTail(loaded, 1)
    expect(bounded.messageOffset).toBe(200 - HISTORY_PAGE_MESSAGES)
    db.save({
      ...bounded,
      messages: [...bounded.messages, message(200, 100)],
      messageCount: 201
    })
    const after = db.get('t')!
    expect(after.messages).toHaveLength(201)
    expect(ordinals(after.messages)).toEqual(Array.from({ length: 201 }, (_, i) => i))
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })
})
