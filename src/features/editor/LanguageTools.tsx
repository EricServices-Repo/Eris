import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanguageCapabilities } from '@/shared/ide-capabilities'
import type { LanguageEditPreview } from '@/shared/language-edit'
import { documentSnapshot, documentMatches } from '@/state/documents'
export function LanguageTools({
  path,
  text,
  position,
  onApplied,
  freeze
}: {
  path: string
  text: string
  position: () => { line: number; character: number }
  onApplied: (content: string) => void
  freeze: (locked: boolean) => void
}) {
  const [cap, setCap] = useState<LanguageCapabilities | null>(null),
    [items, setItems] = useState<LanguageEditPreview[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [name, setName] = useState('')
  const identity = useRef(path)
  identity.current = path
  const captured = useRef<ReturnType<typeof documentSnapshot> | null>(null)
  const refresh = useCallback(() => {
    void window.ide
      .lspCapabilities(path)
      .then((c) => {
        if (identity.current === path) setCap(c)
      })
      .catch((e) => {
        if (identity.current === path) setError(String(e))
      })
  }, [path])
  useEffect(() => {
    setCap(null)
    setItems([])
    setError('')
    const timer = setTimeout(refresh, 300)
    return () => {
      clearTimeout(timer)
      identity.current = ''
    }
  }, [path, refresh]) // initial document-open handshake may still be pending
  const request = async (kind: 'formatting' | 'rename' | 'codeActions') => {
    setBusy(true)
    setError('')
    setItems([])
    const snapshot = documentSnapshot(path, text)
    captured.current = snapshot
    try {
      const pos = position(),
        range = { start: pos, end: pos }
      const result = await window.ide.lspPreviewEdit({
        path,
        text: snapshot.content,
        kind,
        params:
          kind === 'formatting'
            ? { options: { tabSize: 2, insertSpaces: true } }
            : kind === 'rename'
              ? { position: pos, newName: name }
              : { range, context: { diagnostics: [] } }
      })
      if (identity.current !== path || !documentMatches(path, snapshot))
        throw new Error('Document changed while requesting edit. Request a new preview.')
      setItems(result)
      if (!result.length) setError('Adapter returned no actions.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (item: LanguageEditPreview) => {
    if (!item.id || !captured.current) return
    setBusy(true)
    setError('')
    freeze(true)
    try {
      if (identity.current !== path || !documentMatches(path, captured.current))
        throw new Error('Document changed since preview. No edit was applied.')
      const result = await window.ide.lspApplyEdit(item.id)
      if (identity.current === path && documentMatches(path, captured.current))
        onApplied(result.content)
      else
        throw new Error(
          'Disk edit applied; newer editor buffer preserved. Reconcile before saving.'
        )
      setItems([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      freeze(false)
      setBusy(false)
    }
  }
  return (
    <section aria-label="Language actions">
      <div className="diff-actions">
        <button type="button" className="btn" onClick={refresh} disabled={busy}>
          Refresh language capabilities
        </button>
        <span className="subtitle">
          {cap?.ready
            ? `${cap.adapter} · previewed single-document edits`
            : (cap?.reason ?? 'Negotiating language capabilities…')}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy || !cap?.formatting}
          title={!cap?.formatting ? 'Adapter does not advertise formatting' : 'Preview formatting'}
          onClick={() => void request('formatting')}
        >
          Format preview
        </button>
        <input
          aria-label="New symbol name"
          value={name}
          maxLength={256}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || !cap?.rename || !name.trim()}
          title={!cap?.rename ? 'Adapter does not advertise rename' : 'Preview rename at cursor'}
          onClick={() => void request('rename')}
        >
          Rename preview
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !cap?.codeActions}
          title={
            !cap?.codeActions
              ? 'Adapter does not advertise code actions'
              : 'Request text-only actions at cursor'
          }
          onClick={() => void request('codeActions')}
        >
          Code actions
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {items.map((item, i) => (
        <details key={item.id ?? i} open>
          <summary>{item.title}</summary>
          {item.reason ? (
            <p>{item.reason}</p>
          ) : (
            <>
              <p>
                Current file only. Save dirty changes first. Applying publishes through the
                conflict-safe file journal.
              </p>
              <pre
                style={{ maxHeight: 240, overflow: 'auto' }}
              >{`--- Before\n${item.before}\n+++ After\n${item.after}`}</pre>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void apply(item)}
              >
                Apply preview
              </button>
            </>
          )}
        </details>
      ))}
    </section>
  )
}
