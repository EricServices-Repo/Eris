import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const DEFAULT_LEFT = 260
const DEFAULT_RIGHT = 420
const MIN_LEFT = 180
const MIN_RIGHT = 280
const MIN_CENTER = 320
const MAX_LEFT = 560
const MAX_RIGHT = 900

function readStoredWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function useColumnWidths() {
  const [leftWidth, setLeftWidth] = useState(() =>
    clamp(readStoredWidth('eris.leftWidth', DEFAULT_LEFT), MIN_LEFT, MAX_LEFT)
  )
  const [rightWidth, setRightWidth] = useState(() =>
    clamp(readStoredWidth('eris.rightWidth', DEFAULT_RIGHT), MIN_RIGHT, MAX_RIGHT)
  )
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null)
  const leftRef = useRef(leftWidth)
  const rightRef = useRef(rightWidth)
  leftRef.current = leftWidth
  rightRef.current = rightWidth

  useEffect(() => {
    try {
      localStorage.setItem('eris.leftWidth', String(leftWidth))
    } catch {
      /* ignore */
    }
  }, [leftWidth])

  useEffect(() => {
    try {
      localStorage.setItem('eris.rightWidth', String(rightWidth))
    } catch {
      /* ignore */
    }
  }, [rightWidth])

  const startResize = useCallback((side: 'left' | 'right', clientX: number) => {
    const startX = clientX
    const startLeft = leftRef.current
    const startRight = rightRef.current
    setResizing(side)

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const maxForSide = Math.max(
        side === 'left' ? MIN_LEFT : MIN_RIGHT,
        window.innerWidth - MIN_CENTER - (side === 'left' ? startRight : startLeft) - 8
      )
      if (side === 'left') {
        setLeftWidth(clamp(startLeft + dx, MIN_LEFT, Math.min(MAX_LEFT, maxForSide)))
      } else {
        setRightWidth(clamp(startRight - dx, MIN_RIGHT, Math.min(MAX_RIGHT, maxForSide)))
      }
    }

    const onUp = () => {
      setResizing(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const onLeftResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      startResize('left', e.clientX)
    },
    [startResize]
  )

  const onRightResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      startResize('right', e.clientX)
    },
    [startResize]
  )

  const resetLeftWidth = useCallback(() => setLeftWidth(DEFAULT_LEFT), [])
  const resetRightWidth = useCallback(() => setRightWidth(DEFAULT_RIGHT), [])

  return {
    leftWidth,
    rightWidth,
    resizing,
    onLeftResizePointerDown,
    onRightResizePointerDown,
    resetLeftWidth,
    resetRightWidth
  }
}
