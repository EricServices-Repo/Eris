import type { Dispatch, SetStateAction } from 'react'
import type { OpenTab } from './EditorArea'
import { documentMatches, documentSnapshot } from '@/state/documents'

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
const affectedBy = (path: string, targets: string[]) =>
  targets.some((target) => {
    const file = normalize(path),
      affected = normalize(target)
    return file === affected || file.startsWith(affected + '/')
  })

/** Restore disk state without replacing newer/dirty Monaco buffers with a tab snapshot. */
export async function restoreReviewedDocuments(options: {
  targets: string[]
  getTabs: () => OpenTab[]
  current: () => boolean
  restore: () => Promise<unknown>
  readFile: (path: string) => Promise<{ content: string }>
  setTabs: Dispatch<SetStateAction<OpenTab[]>>
}): Promise<void> {
  const captured = options
    .getTabs()
    .filter((tab) => affectedBy(tab.path, options.targets))
    .map((tab) => ({
      tab,
      snapshot: documentSnapshot(tab.path, tab.content)
    }))
  const dirty = captured.find(({ tab, snapshot }) => tab.dirty || snapshot.dirty)
  if (dirty)
    throw new Error(
      `Save or resolve unsaved changes in ${dirty.tab.path} before undoing agent edits.`
    )
  await options.restore()
  if (!options.current()) return
  for (const { tab, snapshot } of captured) {
    if (tab.loaded === false || !documentMatches(tab.path, snapshot)) continue
    let content: string
    try {
      content = (await options.readFile(tab.path)).content
    } catch {
      continue /* Deleted/renamed documents keep their in-memory text. */
    }
    if (!options.current()) return
    options.setTabs((tabs) =>
      tabs.map((current) =>
        current.path === tab.path &&
        !current.dirty &&
        !documentSnapshot(current.path).dirty &&
        documentMatches(current.path, snapshot)
          ? { ...current, content, dirty: false }
          : current
      )
    )
  }
}
