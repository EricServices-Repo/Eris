import { describe, expect, it } from 'vitest'
import {
  bindDocument,
  documentText,
  forgetDocument,
  markDocumentChanged,
  seedDocument,
  snapshotTab
} from '../src/state/documents'

describe('editor document ownership', () => {
  it('reads live unsaved edits for save/chat before the debounced React callback', () => {
    const tab = {
      path: '/example/live.ts',
      name: 'live.ts',
      content: 'saved',
      dirty: false,
      language: 'typescript'
    }
    seedDocument(tab)
    let live = 'saved'
    const release = bindDocument(tab.path, () => live)
    live = 'unsaved text'
    expect(markDocumentChanged(tab.path)).toBe(true)
    expect(markDocumentChanged(tab.path)).toBe(false)
    expect(snapshotTab(tab).content).toBe('unsaved text')
    release()
    expect(documentText(tab.path)).toBe('unsaved text')
    forgetDocument(tab.path)
  })
  it('replaces a stale live reader when disk or accepted patch content arrives', () => {
    const tab = {
      path: '/example/patch.ts',
      name: 'patch.ts',
      content: 'old',
      dirty: false,
      language: 'typescript'
    }
    seedDocument(tab)
    const release = bindDocument(tab.path, () => 'old model')
    seedDocument({ ...tab, content: 'accepted patch' })
    release()
    expect(documentText(tab.path)).toBe('accepted patch')
    forgetDocument(tab.path)
  })
})
