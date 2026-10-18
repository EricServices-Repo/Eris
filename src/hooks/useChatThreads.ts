import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ChatThread } from '@/shared/settings-schema'

export function useChatThreads() {
  const [threads, updateThreads] = useState<ChatThread[]>([])
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null)
  const activeThreadRef = useRef<ChatThread | null>(null)
  activeThreadRef.current = activeThread

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
    if (!current?.messageOffset) return
    const generation = selection.current
    const page = await window.ide.getChat(current.id, { before: current.messageOffset, limit: 60 })
    if (!page || generation !== selection.current) return
    setActiveThread((latest) =>
      latest?.id === current.id && latest.messageOffset === current.messageOffset
        ? {
            ...latest,
            messageOffset: page.messageOffset,
            messages: [...page.messages, ...latest.messages]
          }
        : latest
    )
  }, [])

  return {
    threads,
    setThreads,
    activeThread,
    setActiveThread,
    activeThreadRef,
    refreshChats,
    selectThread,
    loadEarlier
  }
}
