const tick = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
const assert = (value: unknown, reason: string) => {
  if (!value) throw new Error(reason)
}
export async function checkPinDraftRetention(memory: HTMLElement) {
  const original = window.ide.inspectContextMemory
  const note = memory.querySelector<HTMLTextAreaElement>('textarea')!
  const form = note.closest('form')!
  const preview = memory.querySelector<HTMLFormElement>('form')!
  const setNote = async (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, text)
    note.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  }
  const submit = (target: HTMLFormElement) =>
    target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  try {
    await setNote('Always keep this note')
    for (const reason of ['Disk full', 'Invalid controls revision']) {
      window.ide.inspectContextMemory = async (input) => {
        if (input.controls) throw new Error(reason)
        return original(input)
      }
      submit(form)
      await tick()
      assert(note.value === 'Always keep this note', 'Failed pin save must preserve its draft')
      assert(
        memory.querySelector('[role="alert"]')?.textContent?.includes(reason),
        'Pin save failure must remain visible'
      )
      submit(preview)
      await tick()
    }
    let release!: () => void
    window.ide.inspectContextMemory = async (input) => {
      if (input.controls)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return original(input)
    }
    submit(form)
    await tick()
    await setNote('New draft written while saving')
    release()
    await tick()
    assert(
      note.value === 'New draft written while saving',
      'Older success cannot clear a newer draft'
    )
    window.ide.inspectContextMemory = original
    submit(form)
    await tick()
    assert(note.value === '', 'Confirmed save clears the unchanged submitted draft')
  } finally {
    window.ide.inspectContextMemory = original
  }
}
