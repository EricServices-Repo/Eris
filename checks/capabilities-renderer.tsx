import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LanguageTools } from '@/features/editor/LanguageTools'
import { seedDocument, updateDocument, documentText } from '@/state/documents'
import '@/styles/global.css'
declare global {
  interface Window {
    capabilitiesCheck: () => Promise<Record<string, boolean>>
  }
}
const path = '/fixture/current.ts',
  before = 'const old = 1',
  after = 'const renamed = 1'
const freezeEvents: boolean[] = []
let applies = 0,
  defer = false,
  release: (() => void) | undefined
Object.assign(window, {
  ide: {
    lspCapabilities: async () => ({
      version: 1,
      ready: true,
      adapter: 'fixture',
      formatting: true,
      rename: false,
      codeActions: false,
      workspaceEdits: 'single-document-preview'
    }),
    lspPreviewEdit: async () => {
      if (defer)
        await new Promise<void>((r) => {
          release = r
        })
      return [{ id: 'fixture-preview', title: 'Format', path, before, after }]
    },
    lspApplyEdit: async () => {
      applies++
      return { path, content: after }
    }
  }
})
seedDocument({ path, content: before, dirty: false })
function Fixture() {
  const [text, setText] = useState(before)
  return (
    <LanguageTools
      path={path}
      text={text}
      position={() => ({ line: 0, character: 0 })}
      freeze={(v) => freezeEvents.push(v)}
      onApplied={(value) => {
        updateDocument(path, value)
        setText(value)
      }}
    />
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const tick = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await tick()
  }
  throw new Error('Language UI fixture timed out')
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text
  )!
}
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
window.capabilitiesCheck = async () => {
  await until(() => !!button('Format preview') && !button('Format preview').disabled)
  assert(
    button('Rename preview').disabled && button('Code actions').disabled,
    'Unadvertised language actions must be disabled'
  )
  button('Format preview').click()
  await until(() => !!button('Apply preview'))
  assert(
    document.querySelector('pre')?.textContent?.includes(before) &&
      document.querySelector('pre')?.textContent?.includes(after),
    'Preview must disclose before/after'
  )
  updateDocument(path, 'newer user text')
  button('Apply preview').click()
  await tick()
  assert(
    applies === 0 && documentText(path) === 'newer user text',
    'Stale preview must preserve user buffer without publication'
  )
  seedDocument({ path, content: before, dirty: false })
  button('Format preview').click()
  await tick()
  button('Apply preview').click()
  await tick()
  assert(
    applies === 1 && documentText(path) === after,
    'Confirmed current preview updates the document once'
  )
  assert(
    freezeEvents.includes(true) && freezeEvents[freezeEvents.length - 1] === false,
    'Editor freeze must be restored'
  )
  seedDocument({ path, content: before, dirty: false })
  defer = true
  button('Format preview').click()
  await until(() => !!release)
  updateDocument(path, 'changed while requesting')
  release!()
  await tick()
  assert(
    !button('Apply preview') && documentText(path) === 'changed while requesting' && applies === 1,
    'Late response must not resurrect a stale preview'
  )
  return {
    unsupportedDisabled: true,
    beforeAfterPreview: true,
    staleConfirmationBlocked: true,
    confirmedUpdate: true,
    editorUnlocked: true,
    lateResponseBlocked: true
  }
}
