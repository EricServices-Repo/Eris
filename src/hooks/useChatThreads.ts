import { useCallback, useRef, useState } from 'react'
import type { ChatThread } from '@/shared/settings-schema'

export function useChatThreads() {
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null)
  const activeThreadRef = useRef<ChatThread | null>(null)
  activeThreadRef.current = activeThread

  const refreshChats = useCallback(async (preferredId?: string | null) => {
    const list = await window.ide.listChats()
    setThreads(list)
    if (preferredId) {
      const found = list.find((t) => t.id === preferredId) ?? null
      setActiveThread(found)
    } else if (list.length > 0) {
      setActiveThread((prev) => list.find((t) => t.id === prev?.id) ?? list[0])
    } else {
      setActiveThread(null)
    }
  }, [])

  return { threads, setThreads, activeThread, setActiveThread, activeThreadRef, refreshChats }
}
