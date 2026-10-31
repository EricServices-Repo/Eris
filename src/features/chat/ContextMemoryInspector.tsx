import { useRef, useState } from 'react'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import type { ContextItemReason, MemoryControls, MemoryInspection } from '@/shared/context-memory'
import { useInspectorRequests } from '@/hooks/useInspectorRequests'

const OMISSION: Partial<Record<ContextItemReason, string>> = {
  'destination-policy': 'not shared with remote models',
  'input-budget': 'no room in this model’s budget',
  'duplicate-evidence': 'already in the request'
}

export function ContextMemoryInspector({
  threadId,
  workspacePath = null,
  rendererBytes,
  model,
  onOpenMessage
}: {
  threadId: string
  workspacePath?: string | null
  /** Estimated pages held by this window, separate from main-process recall memory. */
  rendererBytes?: number
  /** Destination a preview is compiled for; Auto has none until a turn resolves it. */
  model?: string
  onOpenMessage?: (ordinal: number) => void
}) {
  const draftRevision = useRef(0)
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [note, setNote] = useState('')
  const [snapshot, setSnapshot] = useState<MemoryInspection | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const requests = useInspectorRequests(JSON.stringify([workspacePath, threadId]))
  const close = () => {
    requests.invalidate()
    setBusy(false)
    setOpen(false)
  }
  const focus = useDialogFocus(close)
  const refresh = async (controls?: MemoryControls, evict = false) => {
    const ticket = requests.begin(Boolean(controls) || evict)
    if (!ticket) return false
    setBusy(true)
    setError('')
    try {
      setSnapshot(
        await requests.guard(
          ticket,
          window.ide.inspectContextMemory({
            id: threadId,
            workspacePath,
            snapshotHandle: snapshot?.snapshotHandle,
            query,
            model,
            controls,
            evict
          })
        )
      )
      return true
    } catch (e) {
      if (!requests.current(ticket)) return false
      setError(String(e))
      setSnapshot(null)
      return false
    } finally {
      if (requests.current(ticket)) {
        requests.finish(ticket)
        setBusy(false)
      }
    }
  }
  const controls = snapshot?.controlsAvailable ? snapshot.controls : undefined
  const sendState = (id: string) => {
    const item = snapshot?.preview?.items.find((entry) => entry.id === id)
    if (!item) return ''
    return item.status === 'omitted'
      ? ` · not sent: ${OMISSION[item.reason] ?? 'not selected for this request'}`
      : ' · would be sent'
  }
  return (
    <>
      <button
        className="btn"
        onClick={() => {
          requests.invalidate()
          setSnapshot(null)
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
            {snapshot?.manifest.derivation && (
              <p role="status">
                Source catalog:{' '}
                {snapshot.manifest.derivation.complete
                  ? 'up to date'
                  : `${snapshot.manifest.derivation.pending} changes pending`}
                . Watermark {snapshot.manifest.derivation.watermark}/
                {snapshot.manifest.derivation.highWatermark}. Archive search coverage is separate.
              </p>
            )}
            {snapshot?.lastDispatch && (
              <p>
                Last request to {snapshot.lastDispatch.model} ({snapshot.lastDispatch.destination}):{' '}
                {snapshot.lastDispatch.counts.sent} of {snapshot.lastDispatch.counts.selected}{' '}
                recalled items sent in full, {snapshot.lastDispatch.counts.truncated} shortened,{' '}
                {snapshot.lastDispatch.counts.omitted} left out.
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
            {rendererBytes !== undefined && (
              <p>
                This window holds an estimated {(rendererBytes / 1024 ** 2).toFixed(1)} MiB of
                loaded messages, separate from the recall memory above.
              </p>
            )}
            {error && (
              <p role="alert">
                {error} Your note draft is preserved. Preview again to reload controls before
                retrying.
              </p>
            )}
            {snapshot?.preview ? (
              <p role="status">
                For {snapshot.preview.model} ({snapshot.preview.destination}):{' '}
                {snapshot.preview.counts.sent} sent, {snapshot.preview.counts.omitted} not sent.
                {snapshot.preview.basis === 'last-compilation'
                  ? ` Recompiled with task ${snapshot.preview.taskId}, revision ${snapshot.preview.taskRevision}, and its recorded rules and evidence. Later adapter checks may still remove items.`
                  : ' Estimate only: no matching recent task compilation is available. Task instructions, project rules and retrieval may reduce the actual context.'}
              </p>
            ) : (
              snapshot && <p role="status">Choose a model to preview what it would receive.</p>
            )}
            {snapshot?.projectRoot && <p>Scoped to {snapshot.projectRoot}.</p>}
            <ul>
              {snapshot?.facts.map((f) => (
                <li key={f.id}>
                  <strong>
                    {f.kind} · {f.status}
                  </strong>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{f.text}</p>
                  <small>
                    Source {f.sourceId} · message {f.ordinal + 1}
                    {sendState(f.id)}
                  </small>
                  {onOpenMessage && (
                    <button
                      className="btn"
                      onClick={() => {
                        close()
                        onOpenMessage(f.ordinal)
                      }}
                    >
                      Open message {f.ordinal + 1}
                    </button>
                  )}
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
                if (controls && note.trim()) {
                  const submittedRevision = draftRevision.current
                  const submittedText = note.trim()
                  void refresh({
                    ...controls,
                    pinned: [...controls.pinned, { id: crypto.randomUUID(), text: submittedText }]
                  }).then((saved) => {
                    if (saved && draftRevision.current === submittedRevision) setNote('')
                  })
                }
              }}
            >
              <label>
                Pin an important note
                <textarea
                  value={note}
                  onChange={(e) => {
                    draftRevision.current++
                    setNote(e.target.value)
                  }}
                  maxLength={2000}
                />
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
                    afterSequence: undefined,
                    pinned: []
                  })
              }}
            >
              Stop recalling existing older history
            </button>
            <button className="btn" disabled={busy} onClick={() => void refresh(undefined, true)}>
              Reload RAM from saved history
            </button>
            <button className="btn" onClick={close}>
              Close
            </button>
          </section>
        </div>
      )}
    </>
  )
}
