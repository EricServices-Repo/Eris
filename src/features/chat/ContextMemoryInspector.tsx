import { useState } from 'react'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import type { MemoryControls, MemoryInspection } from '@/shared/context-memory'

export function ContextMemoryInspector({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [note, setNote] = useState('')
  const [snapshot, setSnapshot] = useState<MemoryInspection | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const focus = useDialogFocus(() => setOpen(false))
  const refresh = async (controls?: MemoryControls, evict = false) => {
    setBusy(true)
    setError('')
    try {
      setSnapshot(await window.ide.inspectContextMemory({ id: threadId, query, controls, evict }))
    } catch (e) {
      setError(String(e))
      setSnapshot(null)
    } finally {
      setBusy(false)
    }
  }
  const controls = snapshot?.controlsAvailable ? snapshot.controls : undefined
  return (
    <>
      <button
        className="btn"
        onClick={() => {
          setOpen(true)
          void refresh()
        }}
      >
        Context
      </button>
      {open && (
        <div className="modal-backdrop">
          <section
            ref={focus}
            role="dialog"
            aria-modal="true"
            aria-labelledby="context-memory-title"
            className="modal context-memory-dialog"
            style={{ maxWidth: 720, maxHeight: '80vh', overflow: 'auto', padding: 24 }}
          >
            <h2 id="context-memory-title">Conversation memory</h2>
            <p>
              Detailed history is kept in RAM while this conversation is active. A relevant, limited
              selection is recalled for each message. Older assistant answers are unverified
              evidence.
            </p>
            {snapshot && (
              <p role="status">
                {snapshot.manifest.retainedMessages.toLocaleString()} of{' '}
                {snapshot.manifest.totalMessages.toLocaleString()} messages retained ·{' '}
                {snapshot.manifest.coverage} coverage ·{' '}
                {(snapshot.manifest.logicalBytes / 1024 ** 2).toFixed(1)} MiB logical budget usage ·
                revision {snapshot.manifest.revision}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void refresh()
              }}
            >
              <label>
                Preview recall for a question
                <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={4000} />
              </label>
              <button className="btn" disabled={busy}>
                Preview
              </button>
            </form>
            <p>
              This preview depends on the question. Actual model context can be smaller because of
              its input window. Extra recall is local only unless enabled in Settings → Agent.
            </p>
            {error && <p role="alert">{error}</p>}
            <ul>
              {snapshot?.facts.map((f) => (
                <li key={f.id}>
                  <strong>
                    {f.kind} · {f.status}
                  </strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{f.text}</p>
                  <small>
                    Source {f.sourceId} · message {f.ordinal + 1}
                  </small>
                  {controls && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void refresh({
                          ...controls,
                          forgotten: [...new Set([...controls.forgotten, f.sourceId])]
                        })
                      }
                    >
                      Exclude source from older recall
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (controls && note.trim())
                  void refresh({
                    ...controls,
                    pinned: [...controls.pinned, { id: crypto.randomUUID(), text: note.trim() }]
                  }).then(() => setNote(''))
              }}
            >
              <label>
                Pin an important note
                <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
              </label>
              <button
                className="btn"
                disabled={busy || !controls || !note.trim() || controls.pinned.length >= 100}
              >
                Pin note
              </button>
            </form>
            <ul>
              {controls?.pinned.map((p) => (
                <li key={p.id}>
                  {p.text}
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void refresh({
                        ...controls,
                        pinned: controls.pinned.filter((x) => x.id !== p.id)
                      })
                    }
                  >
                    Unpin
                  </button>
                </li>
              ))}
            </ul>
            <p>
              Excluding older recall preserves your transcript and the ordinary recent conversation
              window.
            </p>
            <button
              className="btn"
              disabled={busy || !controls}
              onClick={() => {
                if (controls && snapshot)
                  void refresh({
                    ...controls,
                    afterOrdinal: snapshot.manifest.totalMessages,
                    pinned: []
                  })
              }}
            >
              Stop recalling existing older history
            </button>
            <button className="btn" disabled={busy} onClick={() => void refresh(undefined, true)}>
              Reload RAM from saved history
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Close
            </button>
          </section>
        </div>
      )}
    </>
  )
}
