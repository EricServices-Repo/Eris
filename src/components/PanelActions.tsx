import { useEffect, useRef, type ReactNode } from 'react'

/** Native disclosure with outside-click dismissal and keyboard focus return. */
export function PanelActions({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        ref.current?.removeAttribute('open')
    }
    const escape = (event: KeyboardEvent) => {
      const node = ref.current
      if (event.key !== 'Escape' || event.defaultPrevented || !node?.open) return
      // Modal dialogs own Escape while they are open.
      if (node.querySelector('[role="dialog"]')) return
      if (event.target instanceof Node && node.contains(event.target)) {
        event.preventDefault()
        node.open = false
        node.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  return (
    <details className="panel-actions" ref={ref}>
      <summary aria-label={label} title={label}>
        •••
      </summary>
      <div className="panel-actions-content" aria-label={label}>
        {children}
      </div>
    </details>
  )
}
