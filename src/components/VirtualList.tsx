import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

function lowerBound(offsets: number[], target: number): number {
  let lo = 0,
    hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (offsets[mid]! <= target) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Variable-height window sharing its nearest marked scrolling ancestor. */
export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimate = 160,
  overscan = 600
}: {
  items: readonly T[]
  itemKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  estimate?: number
  overscan?: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const sizes = useRef(new Map<string, number>())
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const adjustment = useRef({ follow: false, delta: 0 })
  const previousFirstKey = useRef<string | undefined>()
  const keys = useMemo(() => items.map(itemKey), [items, itemKey])
  const offsets = useMemo(() => {
    const result = [0]
    for (const key of keys)
      result.push(result[result.length - 1]! + (sizes.current.get(key) ?? estimate))
    return result
    // Measurements are held in a ref; revision invalidates their prefix sums.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, estimate, revision])
  const first = Math.min(items.length, lowerBound(offsets, Math.max(0, viewport.top - overscan)))
  const last = Math.min(
    items.length,
    lowerBound(offsets, viewport.top + viewport.height + overscan) + 1
  )

  useLayoutEffect(() => {
    const list = container.current
    const scroll = list?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!list || !scroll) return
    let frame = 0
    const update = () => {
      frame = 0
      const listTop =
        list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
      setViewport({ top: Math.max(0, scroll.scrollTop - listTop), height: scroll.clientHeight })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    scroll.addEventListener('scroll', schedule, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(scroll)
    return () => {
      scroll.removeEventListener('scroll', schedule)
      resize.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  useLayoutEffect(() => {
    const scroll = container.current?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!scroll) return
    const inserted = previousFirstKey.current ? keys.indexOf(previousFirstKey.current) : 0
    if (inserted > 0) scroll.scrollTop += offsets[inserted]!
    previousFirstKey.current = keys[0]
    if (adjustment.current.follow) scroll.scrollTop = scroll.scrollHeight
    else if (adjustment.current.delta) scroll.scrollTop += adjustment.current.delta
    adjustment.current = { follow: false, delta: 0 }
  }, [offsets, keys])

  useEffect(() => {
    const active = new Set(keys)
    for (const key of sizes.current.keys()) if (!active.has(key)) sizes.current.delete(key)
  }, [keys])

  useLayoutEffect(() => {
    const list = container.current
    const scroll = list?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!list || !scroll) return
    const resize = new ResizeObserver((entries) => {
      let changed = false
      const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96
      let delta = 0
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const key = node.dataset.virtualKey!
        const height = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height
        const previous = sizes.current.get(key) ?? estimate
        if (height > 0 && Math.abs(previous - height) > 0.5) {
          sizes.current.set(key, height)
          if (node.getBoundingClientRect().bottom < scroll.getBoundingClientRect().top)
            delta += height - previous
          changed = true
        }
      }
      if (changed) {
        adjustment.current = { follow, delta }
        setRevision((value) => value + 1)
      }
    })
    for (const child of list.querySelectorAll<HTMLElement>(':scope > [data-virtual-key]'))
      resize.observe(child)
    return () => resize.disconnect()
  }, [first, last, keys, estimate])

  return (
    <div
      ref={container}
      style={{
        paddingTop: offsets[first],
        paddingBottom: offsets[items.length]! - offsets[last]!,
        overflowAnchor: 'none'
      }}
    >
      {items.slice(first, last).map((item, index) => (
        <div key={keys[first + index]} data-virtual-key={keys[first + index]}>
          {renderItem(item, first + index)}
        </div>
      ))}
    </div>
  )
}
