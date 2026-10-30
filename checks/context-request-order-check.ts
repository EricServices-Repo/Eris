import type { MemoryInspection } from '@/shared/context-memory'
type Input = Parameters<typeof window.ide.inspectContextMemory>[0]
const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
const assert = (value: unknown, reason: string) => {
  if (!value) throw new Error(reason)
}
const opener = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Context'
  )!
const dialog = () =>
  document.querySelector<HTMLElement>('[aria-labelledby="context-memory-title"]')!
const button = (text: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === text
  )!
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
export async function checkInspectorRequestOrdering(
  changeNamespace: (value: string | null) => void
) {
  const original = window.ide.inspectContextMemory
  const pending: Array<{
    input: Input
    resolve: (value: MemoryInspection) => void
    reject: (error: Error) => void
  }> = []
  window.ide.inspectContextMemory = (input) =>
    new Promise((resolve, reject) => {
      pending.push({ input, resolve, reject })
    })
  const respond = async (index: number, revision: number) => {
    const response = await original(pending[index].input)
    pending[index].resolve({ ...response, manifest: { ...response.manifest, revision } })
    await tick()
  }
  const hasRevision = (revision: number) => dialog().textContent?.includes(`revision ${revision}`)
  try {
    opener().click() // preview A
    await tick()
    button('Close').click()
    await tick()
    opener().click() // preview B in reopened view
    await tick()
    await respond(1, 20)
    assert(hasRevision(20), 'Reopened view must accept its own snapshot')
    await respond(0, 10)
    assert(hasRevision(20), 'Late closed-view success must not overwrite the new view')
    submit(dialog().querySelector('form')!) // preview C
    await tick()
    submit(dialog().querySelector('form')!) // preview D supersedes C
    await tick()
    pending[2].reject(new Error('Old preview failure'))
    await tick()
    assert(button('Preview').disabled, 'Old completion must not clear a newer request busy state')
    assert(
      !dialog().querySelector('[role="alert"]'),
      'Old errors must not replace current view state'
    )
    await respond(3, 40)
    assert(hasRevision(40), 'Latest preview publishes')
    const note = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      note,
      'Pending mutation'
    )
    note.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    submit(note.closest('form')!) // mutation E owns the view
    await tick()
    const count = pending.length
    submit(dialog().querySelector('form')!)
    await tick()
    assert(pending.length === count, 'Previews cannot overlap an active mutation')
    assert(button('Preview').disabled, 'Mutation keeps controls busy')
    await respond(4, 50)
    assert(!button('Preview').disabled, 'Current mutation releases busy state')
    submit(dialog().querySelector('form')!) // pending F
    await tick()
    changeNamespace('/fixture-other-workspace') // remount/unmount old consumer
    await tick()
    await respond(5, 60)
    assert(!dialog(), 'Unmounted/old namespace response cannot open a dialog')
    opener().click()
    await tick()
    await respond(6, 70)
    assert(hasRevision(70), 'New namespace accepts only its own fresh request')
    button('Close').click()
    await tick()
  } finally {
    window.ide.inspectContextMemory = original
    changeNamespace(null)
    await tick()
  }
}
