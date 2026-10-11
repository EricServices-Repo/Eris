import { useCallback, useEffect, useState } from 'react'

export type RightPanel = 'editor' | 'terminal' | 'git' | 'debug'

export function useLayout() {
  const [rightPanel, setRightPanel] = useState<RightPanel>('editor')
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    try {
      return localStorage.getItem('eris.leftCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    try {
      return localStorage.getItem('eris.rightCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem('eris.leftCollapsed', leftCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [leftCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem('eris.rightCollapsed', rightCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [rightCollapsed])

  const showRightPanel = useCallback((panel: RightPanel) => {
    setRightPanel(panel)
    setRightCollapsed(false)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    rightPanel,
    setRightPanel,
    leftCollapsed,
    setLeftCollapsed,
    rightCollapsed,
    setRightCollapsed,
    searchOpen,
    setSearchOpen,
    showRightPanel
  }
}
