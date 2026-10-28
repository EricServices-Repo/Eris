import { useLayoutEffect, useRef, useState } from 'react'
import { attachDialogFocus } from '@/components/focus-ownership'
export function useDialogFocus(onDismiss: () => void) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useLayoutEffect(
    () => (node ? attachDialogFocus(node, () => dismiss.current()) : undefined),
    [node]
  )
  return setNode
}
/** Non-modal approval gets safe initial focus and returns it only if the request still owns focus. */
export function useRequestFocus(id: string | undefined) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!id || !node) return
    const previous = document.activeElement as HTMLElement | null
    node.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ preventScroll: true })
    return () => {
      if (document.activeElement === document.body || node.contains(document.activeElement)) {
        const target = previous?.isConnected
          ? previous
          : document.querySelector<HTMLElement>('[data-chat-composer]')
        target?.focus({ preventScroll: true })
      }
    }
  }, [id])
  return ref
}
