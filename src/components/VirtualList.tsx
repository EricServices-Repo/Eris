import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

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
  overscan = 600,
  preserveInteraction = false,
  reveal,
  semanticLabel
}: {
  items: readonly T[]
  itemKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  estimate?: number
  overscan?: number
  preserveInteraction?: boolean
  reveal?: { key: string; request: number } | null
  semanticLabel?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const sizes = useRef(new Map<string, number>())
  const [selectedRange, setSelectedRange] = useState<{ first: string; last: string } | null>(null)
  const focusedElement = useRef<HTMLElement | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const rangeRef = useRef({ first: 0, last: 0 })
  const layoutRef = useRef<{ keys: string[]; offsets: number[] }>({ keys: [], offsets: [] })
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const adjustment = useRef({ follow: false, delta: 0 })
  const previousLayout = useRef<{ keys: string[]; offsets: number[] }>({ keys: [], offsets: [] })
  const reconcileViewport = useCallback(() => {
    const list = container.current
    const scroll = list?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!list || !scroll) return
    const listTop =
      list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    const top = Math.max(0, scroll.scrollTop - listTop)
    const height = scroll.clientHeight
    setViewport((previous) =>
      previous.top === top && previous.height === height ? previous : { top, height }
    )
  }, [])
  const keys = useMemo(() => items.map(itemKey), [items, itemKey])
  const offsets = useMemo(() => {
    const result = [0]
    for (const key of keys)
      result.push(result[result.length - 1]! + (sizes.current.get(key) ?? estimate))
    return result
    // Measurements are held in a ref; revision invalidates their prefix sums.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, estimate, revision])
  const viewportFirst = Math.min(
    items.length,
    lowerBound(offsets, Math.max(0, viewport.top - overscan))
  )
  const viewportLast = Math.min(
    items.length,
    lowerBound(offsets, viewport.top + viewport.height + overscan) + 1
  )

  const selectedFirst = selectedRange ? keys.indexOf(selectedRange.first) : -1
  const selectedLast = selectedRange ? keys.indexOf(selectedRange.last) : -1
  const first = selectedFirst >= 0 ? selectedFirst : viewportFirst
  const last = Math.min(
    items.length,
    first + 119,
    selectedLast >= first ? selectedLast + 1 : viewportLast
  )
  rangeRef.current = { first, last }
  layoutRef.current = { keys, offsets }
  const liveFocus =
    preserveInteraction &&
    typeof document !== 'undefined' &&
    container.current?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-virtual-key]')?.dataset
          .virtualKey
      : null
  const retainedFocus = liveFocus ?? focusedKey
  const rendered = useMemo(() => {
    const indices = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i),
      pinned = retainedFocus ? keys.indexOf(retainedFocus) : -1
    if (pinned >= 0 && !indices.includes(pinned)) indices.push(pinned)
    return indices.sort((a, b) => a - b)
  }, [first, last, retainedFocus, keys])
  useLayoutEffect(() => {
    if (!preserveInteraction) return
    const list = container.current
    if (!list) return
    const update = () => {
      const active = document.activeElement
      const row =
        active instanceof Element && list.contains(active)
          ? active.closest<HTMLElement>('[data-virtual-key]')
          : null
      if (row && active instanceof HTMLElement) focusedElement.current = active
      else if (active !== document.body) focusedElement.current = null
      setFocusedKey(row?.dataset.virtualKey ?? null)
      const selection = window.getSelection()
      if (
        selection &&
        !selection.isCollapsed &&
        (list.contains(selection.anchorNode) || list.contains(selection.focusNode))
      ) {
        setSelectedRange(
          (previous) =>
            previous ?? {
              first: layoutRef.current.keys[rangeRef.current.first],
              last: layoutRef.current.keys[
                Math.max(rangeRef.current.first, rangeRef.current.last - 1)
              ]
            }
        )
      } else setSelectedRange(null)
    }
    let disposed = false
    const blur = () =>
      queueMicrotask(() => {
        if (!disposed) update()
      })
    const pointer = (event: PointerEvent) => {
      if (!list.contains(event.target as Node)) {
        focusedElement.current = null
        setFocusedKey(null)
      }
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('selectionchange', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', blur)
    return () => {
      disposed = true
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', blur)
    }
  }, [preserveInteraction])
  // Moving a keyed DOM row across spacer siblings can blur its control in Chromium.
  // Restore only that retained control; an explicit outside pointer/focus clears it.
  useLayoutEffect(() => {
    const node = focusedElement.current
    if (
      preserveInteraction &&
      focusedKey &&
      node?.isConnected &&
      document.activeElement === document.body
    )
      node.focus({ preventScroll: true })
  })
  useLayoutEffect(() => {
    if (!reveal) return
    const list = container.current,
      scroll = list?.closest<HTMLElement>('[data-virtual-scroll]'),
      layout = layoutRef.current,
      index = layout.keys.indexOf(reveal.key)
    if (!list || !scroll || index < 0) return
    const top =
      list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    scroll.scrollTop = top + layout.offsets[index]
    scroll.dispatchEvent(new Event('scroll'))
  }, [reveal])

  useLayoutEffect(() => {
    const list = container.current
    const scroll = list?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!list || !scroll) return
    let frame = 0
    const update = () => {
      frame = 0
      reconcileViewport()
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
  }, [reconcileViewport])

  useLayoutEffect(() => {
    const scroll = container.current?.closest<HTMLElement>('[data-virtual-scroll]')
    if (!scroll) return
    const previous = previousLayout.current
    const inserted = previous.keys.length ? keys.indexOf(previous.keys[0]!) : 0
    if (inserted > 0) scroll.scrollTop += offsets[inserted]!
    else if (inserted < 0) {
      // Rows left the top of the list: the kept rows move up by their old height.
      const present = new Set(keys)
      const kept = previous.keys.findIndex((key) => present.has(key))
      if (kept > 0)
        scroll.scrollTop -= previous.offsets[kept]! - offsets[keys.indexOf(previous.keys[kept]!)]!
    }
    previousLayout.current = { keys, offsets }
    if (adjustment.current.follow) scroll.scrollTop = scroll.scrollHeight
    else if (adjustment.current.delta) scroll.scrollTop += adjustment.current.delta
    adjustment.current = { follow: false, delta: 0 }
    // Native scroll notifications are asynchronous and may be omitted in a hidden window.
    // Reconcile before paint so prepends/measurements cannot leave the rendered range stale.
    reconcileViewport()
  }, [offsets, keys, reconcileViewport])

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
  }, [first, last, keys, estimate, focusedKey])

  let cursor = 0
  const nodes: ReactNode[] = []
  for (const index of rendered) {
    const gap = offsets[index] - offsets[cursor]
    if (gap > 0)
      nodes.push(
        <div
          key={`gap:${keys[index]}`}
          aria-hidden="true"
          style={{ height: gap, pointerEvents: 'none' }}
        />
      )
    nodes.push(
      <div
        key={keys[index]}
        data-virtual-key={keys[index]}
        role={semanticLabel ? 'listitem' : undefined}
        aria-posinset={semanticLabel ? index + 1 : undefined}
        aria-setsize={semanticLabel ? items.length : undefined}
      >
        {renderItem(items[index], index)}
      </div>
    )
    cursor = index + 1
  }
  if (cursor < items.length)
    nodes.push(
      <div
        key="tail-gap"
        aria-hidden="true"
        style={{ height: offsets[items.length] - offsets[cursor], pointerEvents: 'none' }}
      />
    )
  return (
    <div
      ref={container}
      data-retained-focus={retainedFocus ?? undefined}
      role={semanticLabel ? 'list' : undefined}
      aria-label={semanticLabel}
      style={{ overflowAnchor: 'none' }}
    >
      {nodes}
    </div>
  )
}
