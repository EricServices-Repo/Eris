const scopes: HTMLElement[] = []
const inertNodes = new Map<HTMLElement, boolean>()
function isolateTopDialog() {
  for (const [node, original] of inertNodes) node.inert = original
  inertNodes.clear()
  let branch: HTMLElement | null = scopes[scopes.length - 1] ?? null
  while (branch && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertNodes.set(sibling, sibling.inert)
        sibling.inert = true
      }
    }
    branch = parent
  }
}
const interactive =
  'input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="menu"],[role="menuitem"],[role="listbox"],[role="slider"],.monaco-editor,.xterm,[data-keyboard-owner]'
export function ownsReviewShortcut(event: KeyboardEvent, root: HTMLElement): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return false
  const target = event.target
  if (!(target instanceof Element) || !root.contains(target)) return false
  if (scopes.length) return false
  const owner = target.closest(interactive)
  return !owner || owner === root
}
function focusable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')]
    .filter(
      (n) =>
        n.tabIndex >= 0 &&
        !n.matches(':disabled') &&
        !n.closest('[hidden],[inert],[aria-hidden="true"]') &&
        n.getClientRects().length > 0
    )
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
}
/** Modal stack owns Tab/Escape and restores only its own focus. No authority or decision is implied. */
export function attachDialogFocus(root: HTMLElement, dismiss: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  scopes.push(root)
  isolateTopDialog()
  const first = () =>
    root.querySelector<HTMLElement>('[data-initial-focus]') ?? focusable(root)[0] ?? root
  first().focus({ preventScroll: true })
  const key = (e: KeyboardEvent) => {
    if (scopes[scopes.length - 1] !== root || e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      dismiss()
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const items = focusable(root),
        index = items.indexOf(document.activeElement as HTMLElement)
      const next =
        index < 0
          ? e.shiftKey
            ? items.length - 1
            : 0
          : (index + (e.shiftKey ? -1 : 1) + items.length) % items.length
      ;(items[next] ?? root).focus({ preventScroll: true })
    }
  }
  const guard = (event: FocusEvent) => {
    if (scopes[scopes.length - 1] === root && !root.contains(event.target as Node))
      first().focus({ preventScroll: true })
  }
  document.addEventListener('keydown', key, true)
  document.addEventListener('focusin', guard, true)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const owned = scopes[scopes.length - 1] === root
    scopes.splice(scopes.indexOf(root), 1)
    isolateTopDialog()
    document.removeEventListener('keydown', key, true)
    document.removeEventListener('focusin', guard, true)
    if (!owned) return
    const parent = scopes[scopes.length - 1]
    if (previous?.isConnected && (!parent || parent.contains(previous)))
      previous.focus({ preventScroll: true })
    else if (parent) (focusable(parent)[0] ?? parent).focus({ preventScroll: true })
    else document.querySelector<HTMLElement>('[data-chat-composer]')?.focus({ preventScroll: true })
  }
}
