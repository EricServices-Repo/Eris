import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { ChatThread } from '@/shared/settings-schema'
import {
  addEarlierPage,
  addLaterPage,
  boundTail,
  emptyHistoryWindow,
  historyView,
  HISTORY_PAGE_MESSAGES,
  windowEnd,
  windowStart
} from '@/shared/chat-history-window'

export function useChatThreads() {
  const [threads, updateThreads] = useState<ChatThread[]>([])
  const [activeThread, setBoundedThread] = useState<ChatThread | null>(null)
  const activeThreadRef = useRef<ChatThread | null>(null)
  activeThreadRef.current = activeThread
  const [storedWindow, setHistoryWindow] = useState(emptyHistoryWindow)
  const historyWindow =
    storedWindow.threadId === activeThread?.id
      ? storedWindow
      : emptyHistoryWindow(activeThread?.id ?? null)
  const historyWindowRef = useRef(historyWindow)
  historyWindowRef.current = historyWindow
  const history = useMemo(
    () => historyView(historyWindow, activeThread),
    [historyWindow, activeThread]
  )
  const setActiveThread: Dispatch<SetStateAction<ChatThread | null>> = useCallback((next) => {
    setBoundedThread((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      return value && boundTail(value)
    })
  }, [])
  // A new message belongs after the tail, so a reader parked in old pages returns to it.
  const tailLength = activeThread?.messages.length
  useEffect(() => {
    if (historyView(historyWindowRef.current, activeThreadRef.current).gap)
      setHistoryWindow(emptyHistoryWindow())
  }, [tailLength])

  const selection = useRef(0)
  const setThreads: Dispatch<SetStateAction<ChatThread[]>> = useCallback((next) => {
    updateThreads((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      return value.map((thread) => ({
        ...thread,
        messageCount: thread.messageCount ?? (thread.messageOffset ?? 0) + thread.messages.length,
        messages: []
      }))
    })
  }, [])
  const selectThread = useCallback(async (id: string | null) => {
    const generation = ++selection.current
    if (!id) {
      setActiveThread(null)
      return
    }
    const thread = await window.ide.getChat(id)
    if (selection.current === generation) setActiveThread(thread)
  }, [])
  const refreshChats = useCallback(
    async (preferredId?: string | null) => {
      const generation = ++selection.current
      const list = await window.ide.listChats()
      if (generation !== selection.current) return
      setThreads(list)
      const id =
        preferredId ??
        (list.some((thread) => thread.id === activeThreadRef.current?.id)
          ? activeThreadRef.current?.id
          : list[0]?.id)
      const thread = id ? await window.ide.getChat(id) : null
      if (generation === selection.current) setActiveThread(thread)
    },
    [setThreads]
  )
  const loadEarlier = useCallback(async () => {
    const current = activeThreadRef.current
    if (!current) return
    const before = windowStart(historyWindowRef.current) ?? current.messageOffset ?? 0
    if (!before) return
    const generation = selection.current
    const page = await window.ide.getChat(current.id, {
      before,
      limit: HISTORY_PAGE_MESSAGES
    })
    if (!page || generation !== selection.current) return
    setHistoryWindow((latest) => {
      const base = latest.threadId === current.id ? latest : emptyHistoryWindow(current.id)
      if ((windowStart(base) ?? current.messageOffset ?? 0) !== before) return latest
      return addEarlierPage(base, page.messageOffset ?? 0, page.messages)
    })
  }, [])
  /** Reload pages evicted between the window and the live tail. */
  const loadNewer = useCallback(async () => {
    const current = activeThreadRef.current
    const end = windowEnd(historyWindowRef.current)
    if (!current || end === undefined) return
    const tailStart = current.messageOffset ?? 0
    if (end >= tailStart) return
    const generation = selection.current
    const limit = Math.min(HISTORY_PAGE_MESSAGES, tailStart - end)
    const page = await window.ide.getChat(current.id, { before: end + limit, limit })
    if (!page || generation !== selection.current) return
    setHistoryWindow((latest) =>
      latest.threadId === current.id && windowEnd(latest) === end
        ? addLaterPage(latest, end, page.messages)
        : latest
    )
  }, [])
  const jumpToLatest = useCallback(() => setHistoryWindow(emptyHistoryWindow()), [])

  return {
    threads,
    setThreads,
    activeThread,
    setActiveThread,
    activeThreadRef,
    refreshChats,
    selectThread,
    loadEarlier,
    loadNewer,
    jumpToLatest,
    history
  }
}
