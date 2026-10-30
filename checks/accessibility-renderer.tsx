import { ContextMemoryInspector } from '@/features/chat/ContextMemoryInspector'
import { emptyMemoryControls } from '@/shared/context-memory'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { CreateWorkspaceModal } from '@/features/workspace/CreateWorkspaceModal'
import { CommandPalette } from '@/features/palette/CommandPalette'
import { DiffReview, type PendingDiff } from '@/features/chat/DiffReview'
import { useRequestFocus } from '@/hooks/useDialogFocus'
import { ownsReviewShortcut } from '@/components/focus-ownership'
import '@/styles/global.css'
declare global {
  interface Window {
    accessibilityCheck: () => Promise<Record<string, boolean>>
  }
}
let open: (v: boolean) => void, nested: (v: boolean) => void, approval: (v: boolean) => void
let changeMemoryNamespace: (value: string | null) => void
let undoCount = 0
const diffs: PendingDiff[] = [
  {
    id: 'one',
    checkpointId: 'fixture',
    opIndex: 0,
    path: 'folder',
    before: null,
    after: '',
    op: 'mkdir',
    status: 'pending'
  }
]
function Approval({ active }: { active: boolean }) {
  const ref = useRequestFocus(active ? 'approval-owned' : undefined)
  return active ? (
    <div ref={ref} role="region" aria-label="Permission required">
      <button onClick={() => approval(false)}>Allow once</button>
      <button data-initial-focus onClick={() => approval(false)}>
        Deny
      </button>
    </div>
  ) : null
}
function Fixture() {
  const [modal, setModal] = useState(false),
    [palette, setPalette] = useState(false),
    [pending, setPending] = useState(false)
  const [memoryNamespace, setMemoryNamespace] = useState<string | null>(null)
  changeMemoryNamespace = setMemoryNamespace
  open = setModal
  nested = setPalette
  approval = setPending
  return (
    <>
      <textarea data-chat-composer aria-label="Chat message" />
      <Approval active={pending} />
      <ContextMemoryInspector
        key={memoryNamespace ?? 'global'}
        threadId="memory-fixture"
        workspacePath={memoryNamespace}
      />
      <div className="monaco-editor">
        <div role="textbox" contentEditable suppressContentEditableWarning>
          editor
        </div>
      </div>
      <DiffReview
        diffs={diffs}
        onKeep={() => {}}
        onUndoFile={() => undoCount++}
        onUndoAll={() => undoCount++}
        onKeepAll={() => {}}
        onOpenPath={() => {}}
      />
      <CreateWorkspaceModal
        open={modal}
        mode="create"
        onSubmit={() => {}}
        onClose={() => setModal(false)}
      />
      <CommandPalette
        open={palette}
        commands={[{ id: 'test', label: 'Test command', run: () => {} }]}
        onClose={() => setPalette(false)}
      />
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const tick = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const assert = (v: unknown, label: string) => {
  if (!v) throw new Error(label)
}
function key(node: Element, key: string, shiftKey = false) {
  node.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  )
}
window.accessibilityCheck = async () => {
  let controls = emptyMemoryControls()
  window.ide = {
    ...window.ide,
    inspectContextMemory: async (input) => {
      controls = input.controls ?? controls
      return {
        manifest: {
          version: 1,
          revision: 7,
          generation: 3,
          totalMessages: 10001,
          retainedMessages: 10001,
          firstOrdinal: 0,
          logicalBytes: 12 * 1024 ** 2,
          coverage: 'complete',
          selectedIds: ['fact'],
          sourceIds: ['source'],
          estimatedTokens: 100,
          omittedFacts: 20
        },
        facts: controls.forgotten.length
          ? []
          : [
              {
                id: 'fact',
                sourceId: 'source',
                ordinal: 2,
                kind: 'user-stated',
                status: 'user-stated',
                text: 'Remember: rental checkout must use CAD.'
              }
            ],
        controls,
        controlsAvailable: true,
        processLogicalBytes: 12 * 1024 ** 2
      }
    }
  }

  await tick()
  const composer = document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')!
  composer.focus()
  flushSync(() => approval(true))
  await tick()
  assert(document.activeElement?.textContent === 'Deny', 'Approval must focus safe choice')
  ;(document.activeElement as HTMLButtonElement).click()
  await tick()
  assert(document.activeElement === composer, 'Approval must return to composer')
  flushSync(() => open(true))
  await tick()
  const modal = document.querySelector<HTMLElement>('[aria-label="Workspace"]')!
  assert(modal.contains(document.activeElement), 'Modal initial focus')
  const buttons = [...modal.querySelectorAll<HTMLElement>('button,input')].filter(
    (n) => !n.matches(':disabled')
  )
  buttons[buttons.length - 1]!.focus()
  key(document.activeElement!, 'Tab')
  assert(document.activeElement === buttons[0], 'Tab wraps forward')
  key(document.activeElement!, 'Tab', true)
  assert(document.activeElement === buttons[buttons.length - 1], 'Shift Tab wraps backward')
  composer.focus()
  await tick()
  assert(
    modal.contains(document.activeElement),
    'Background cannot steal modal focus: ' +
      document.activeElement?.outerHTML.slice(0, 180) +
      ' focus=' +
      document.hasFocus() +
      ' dialog=' +
      modal.outerHTML.slice(0, 200)
  )
  const opener = document.activeElement
  flushSync(() => nested(true))
  await tick()
  const palette = document.querySelector('[aria-label="Commands"]')!
  assert(palette.contains(document.activeElement), 'Nested dialog initial focus')
  key(document.activeElement!, 'Escape')
  await tick()
  assert(!document.querySelector('[aria-label="Commands"]'), 'Escape closes top dialog')
  assert(document.activeElement === opener, 'Nested close returns to parent owner')
  key(document.activeElement!, 'Escape')
  await tick()
  assert(document.activeElement === composer, 'Modal closes back to composer')
  const review = document.querySelector<HTMLElement>('.diff-review')!
  let observed: KeyboardEvent | null = null
  const capture = (e: KeyboardEvent) => {
    observed = e
  }
  review.addEventListener('keydown', capture)
  review.focus()
  key(review, 'n')
  assert(observed && (observed as KeyboardEvent).defaultPrevented, 'Review owns its own N shortcut')
  for (const selector of ['button', '.monaco-editor [role="textbox"]', '[data-chat-composer]']) {
    const control = document.querySelector<HTMLElement>(selector)!
    let denied = false
    const check = (e: KeyboardEvent) => {
      denied = !ownsReviewShortcut(e, review)
    }
    control.addEventListener('keydown', check)
    control.focus()
    key(control, 'j')
    control.removeEventListener('keydown', check)
    assert(denied, 'Interactive control must own its input: ' + selector)
  }
  const undo = [...review.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Undo file'
  )!
  undo.focus()
  key(undo, 'j')
  undo.click()
  assert(undoCount === 1, 'Keyboard-reachable undo action invoked once')
  const contextButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Context'
  )!
  contextButton.focus()
  contextButton.click()
  await tick()
  const memory = document.querySelector<HTMLElement>('[aria-labelledby="context-memory-title"]')!
  assert(memory?.contains(document.activeElement), 'Memory inspector owns initial focus')
  assert(
    memory.textContent?.includes('10,001 of 10,001'),
    'Memory shows full retained history coverage'
  )
  assert(memory.textContent?.includes('checkout must use CAD'), 'Memory source preview visible')
  const exclude = [...memory.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Exclude source from older recall'
  )!
  exclude.click()
  await tick()
  assert(
    !memory.textContent?.includes('checkout must use CAD'),
    'Source exclusion refreshes preview'
  )
  key(document.activeElement!, 'Escape')
  await tick()
  assert(
    !document.querySelector('[aria-labelledby="context-memory-title"]'),
    'Escape closes memory inspector'
  )
  assert(document.activeElement === contextButton, 'Memory inspector returns focus to opener')
  await (
    await import('./context-request-order-check')
  ).checkInspectorRequestOrdering((value) => flushSync(() => changeMemoryNamespace(value)))
  composer.focus()
  return {
    contextInspector: true,
    inspectorRequestOrdering: true,

    approvalSafeFocus: true,
    approvalReturn: true,
    modalTrap: true,
    nestedEscape: true,
    modalReturn: true,
    reviewScoped: true,
    editorInputOwned: true,
    undoReachable: true
  }
}
