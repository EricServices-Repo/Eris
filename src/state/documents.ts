const notifyChange = (path: string, dirty: boolean) => {
  const renderer = (
    globalThis as {
      window?: { ide?: { notifyDocumentChange?: (path: string, dirty: boolean) => void } }
    }
  ).window
  renderer?.ide?.notifyDocumentChange?.(path, dirty)
}
type DocumentTab = { path: string; content: string; dirty: boolean }
type Document = { content: string; dirty: boolean; version: number; read?: () => string }
const documents = new Map<string, Document>()
/** Capture both the Monaco text and document identity, including changes not flushed to tabs yet. */
export function documentSnapshot(path: string, fallback = '') {
  const revision = documents.get(path)
  return { revision, content: documentText(path, fallback), dirty: revision?.dirty ?? false }
}
export function documentMatches(
  path: string,
  snapshot: ReturnType<typeof documentSnapshot>
): boolean {
  return (
    documents.get(path) === snapshot.revision &&
    documentText(path, snapshot.content) === snapshot.content
  )
}
export function seedDocument(tab: DocumentTab): void {
  const previous = documents.get(tab.path)
  if (tab.dirty || previous?.dirty) notifyChange(tab.path, tab.dirty)
  documents.set(tab.path, {
    content: tab.content,
    dirty: tab.dirty,
    version: (previous?.version ?? 0) + 1
  })
}
export function updateDocument(path: string, content: string): void {
  notifyChange(path, true)
  const previous = documents.get(path)
  documents.set(path, { ...previous, content, dirty: true, version: (previous?.version ?? 0) + 1 })
}
export function documentText(path: string, fallback = ''): string {
  const doc = documents.get(path)
  return doc?.read?.() ?? doc?.content ?? fallback
}
export function snapshotTab<T extends DocumentTab>(tab: T): T {
  return { ...tab, content: documentText(tab.path, tab.content) }
}
export function bindDocument(path: string, read: () => string): () => void {
  const previous = documents.get(path) ?? { content: read(), dirty: false, version: 0 }
  documents.set(path, { ...previous, read })
  return () => {
    const current = documents.get(path)
    if (current?.read === read)
      documents.set(path, { ...current, content: read(), read: undefined })
  }
}
export function forgetDocument(path: string): void {
  if (documents.get(path)?.dirty) notifyChange(path, false)
  documents.delete(path)
}
export function markDocumentChanged(path: string): boolean {
  notifyChange(path, true)
  const previous = documents.get(path) ?? { content: '', dirty: false, version: 0 }
  documents.set(path, { ...previous, dirty: true, version: previous.version + 1 })
  return !previous.dirty
}
