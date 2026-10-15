import { useState } from 'react'

const PIN_MAX = 800

function applyDoc(
  doc: { body: string; pin: string },
  setBody: (v: string) => void,
  setSummary: (v: string) => void,
  setBodyDirty: (v: boolean) => void,
  setSummaryDirty: (v: boolean) => void,
  setError: (v: string | null) => void
) {
  setBody(doc.body)
  setSummary(doc.pin)
  setBodyDirty(false)
  setSummaryDirty(false)
  setError(null)
}

export function useContextPanelState(hasWorkspace: boolean) {
  const [contextBody, setContextBody] = useState('')
  const [summary, setSummary] = useState('')
  const [bodyDirty, setBodyDirty] = useState(false)
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [contextSaving, setContextSaving] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [contextNote, setContextNote] = useState('')
  const [showFull, setShowFull] = useState(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const [canUndoMemory, setCanUndoMemory] = useState(false)

  const loadWorkspaceContextDoc = async () => {
    if (!hasWorkspace) {
      setContextBody('')
      setSummary('')
      setBodyDirty(false)
      setSummaryDirty(false)
      return
    }
    try {
      const doc = await window.ide.getWorkspaceContext()
      applyDoc(doc, setContextBody, setSummary, setBodyDirty, setSummaryDirty, setContextError)
      // Expand full doc when there is more than an empty starter summary
      if (doc.body.trim() && !doc.empty) setShowFull(true)
      setCanUndoMemory(await window.ide.canUndoProjectMemory())
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to load context')
    }
  }

  return {
    contextBody,
    setContextBody,
    summary,
    setSummary,
    bodyDirty,
    setBodyDirty,
    summaryDirty,
    setSummaryDirty,
    contextSaving,
    setContextSaving,
    contextError,
    setContextError,
    contextNote,
    setContextNote,
    showFull,
    setShowFull,
    noteBusy,
    setNoteBusy,
    canUndoMemory,
    setCanUndoMemory,
    loadWorkspaceContextDoc
  }
}

export type ContextPanelState = ReturnType<typeof useContextPanelState>

export function ContextPanel({
  state,
  hasWorkspace
}: {
  state: ContextPanelState
  hasWorkspace: boolean
}) {
  const {
    contextBody,
    setContextBody,
    summary,
    setSummary,
    bodyDirty,
    setBodyDirty,
    summaryDirty,
    setSummaryDirty,
    contextSaving,
    setContextSaving,
    contextError,
    setContextError,
    contextNote,
    setContextNote,
    showFull,
    setShowFull,
    noteBusy,
    setNoteBusy,
    canUndoMemory,
    setCanUndoMemory,
    loadWorkspaceContextDoc
  } = state

  const summaryLen = summary.trim().length
  const overLimit = summaryLen > PIN_MAX

  const persistSummary = async () => {
    setContextSaving(true)
    try {
      const doc = await window.ide.setWorkspaceContextSummary(summary)
      applyDoc(doc, setContextBody, setSummary, setBodyDirty, setSummaryDirty, setContextError)
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to save summary')
    } finally {
      setContextSaving(false)
    }
  }

  const persistBody = async () => {
    setContextSaving(true)
    try {
      const doc = await window.ide.saveWorkspaceContext(contextBody)
      applyDoc(doc, setContextBody, setSummary, setBodyDirty, setSummaryDirty, setContextError)
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to save context')
    } finally {
      setContextSaving(false)
    }
  }

  const appendNote = async () => {
    if (!contextNote.trim()) return
    setNoteBusy(true)
    try {
      const doc = await window.ide.appendWorkspaceContextNote(contextNote)
      applyDoc(doc, setContextBody, setSummary, setBodyDirty, setSummaryDirty, setContextError)
      setContextNote('')
      setShowFull(true)
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to append note')
    } finally {
      setNoteBusy(false)
    }
  }

  return (
    <div className="context-page">
      {!hasWorkspace ? (
        <section className="models-card">
          <header className="models-card-head">
            <div>
              <h3>Project context</h3>
              <p>Open a workspace to edit <code>.eris/context.md</code>.</p>
            </div>
          </header>
        </section>
      ) : (
        <>
          <section className="models-card">
            <header className="models-card-head">
              <div>
                <h3>Summary</h3>
                <p>Pinned into every chat turn. Keep it short and factual.</p>
              </div>
              <span
                className={`models-tag${summary.trim() ? ' is-accent' : ''}`}
                title="Characters in the pinned summary"
              >
                {summaryLen}/{PIN_MAX}
              </span>
            </header>
            <textarea
              className="context-summary-input"
              rows={5}
              value={summary}
              spellCheck
              placeholder={`Project: …\nStack: …\nRun: …\nConventions: …`}
              onChange={(e) => {
                setSummary(e.target.value)
                setSummaryDirty(true)
              }}
            />
            {overLimit && (
              <p className="models-inline-msg" data-tone="danger">
                Over {PIN_MAX} characters — the pin will be truncated in chat.
              </p>
            )}
            <div className="context-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!summaryDirty || contextSaving}
                onClick={() => void persistSummary()}
              >
                {contextSaving && summaryDirty ? 'Saving…' : 'Save summary'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={contextSaving || (!summaryDirty && !bodyDirty)}
                onClick={() => void loadWorkspaceContextDoc()}
              >
                Reload
              </button>
            </div>
            <p className="models-hint">
              Tip: stack, entrypoints, run commands, and hard rules. Longer detail belongs in
              Reference below. Agent runs can auto-append Notes (Settings → Agent → Project
              memory).
            </p>
            {canUndoMemory && (
              <div className="context-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={contextSaving}
                  onClick={() => {
                    setContextSaving(true)
                    void window.ide
                      .undoProjectMemory()
                      .then((doc) => {
                        applyDoc(
                          doc,
                          setContextBody,
                          setSummary,
                          setBodyDirty,
                          setSummaryDirty,
                          setContextError
                        )
                        setCanUndoMemory(Boolean(doc.ok))
                      })
                      .catch((err: unknown) => {
                        setContextError(
                          err instanceof Error ? err.message : 'Failed to undo memory'
                        )
                      })
                      .finally(() => setContextSaving(false))
                  }}
                >
                  Undo last memory write
                </button>
              </div>
            )}
          </section>

          <section className="models-card">
            <header className="models-card-head">
              <div>
                <h3>Quick note</h3>
                <p>Appends a dated bullet under Notes in the full document.</p>
              </div>
            </header>
            <div className="context-note-row">
              <input
                value={contextNote}
                placeholder="e.g. Auth lives in src/lib/auth.ts"
                onChange={(e) => setContextNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !contextNote.trim()) return
                  e.preventDefault()
                  void appendNote()
                }}
                disabled={noteBusy || contextSaving}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!contextNote.trim() || noteBusy || contextSaving}
                onClick={() => void appendNote()}
              >
                {noteBusy ? '…' : 'Append'}
              </button>
            </div>
          </section>

          <section className="models-card">
            <header className="models-card-head">
              <div>
                <h3>Full document</h3>
                <p>
                  <code>.eris/context.md</code> — Reference and Notes. Loaded on demand via{' '}
                  <code>read_context</code>.
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setShowFull((v) => !v)}>
                {showFull ? 'Hide' : 'Edit'}
              </button>
            </header>

            {!showFull ? (
              <p className="models-empty">
                Hidden to keep this page simple. Open it to edit Reference, Notes, or the raw
                markdown.
              </p>
            ) : (
              <>
                <textarea
                  className="context-full-input"
                  rows={14}
                  value={contextBody}
                  spellCheck={false}
                  onChange={(e) => {
                    setContextBody(e.target.value)
                    setBodyDirty(true)
                  }}
                />
                <div className="context-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!bodyDirty || contextSaving}
                    onClick={() => void persistBody()}
                  >
                    {contextSaving && bodyDirty ? 'Saving…' : 'Save document'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={contextSaving}
                    onClick={() => {
                      if (
                        (summaryDirty || bodyDirty) &&
                        !window.confirm('Discard unsaved edits and reload from disk?')
                      ) {
                        return
                      }
                      void loadWorkspaceContextDoc()
                    }}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={contextSaving}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Replace context.md with the starter template? This overwrites the file.'
                        )
                      ) {
                        return
                      }
                      setContextSaving(true)
                      void window.ide
                        .resetWorkspaceContext()
                        .then((doc) => {
                          applyDoc(
                            doc,
                            setContextBody,
                            setSummary,
                            setBodyDirty,
                            setSummaryDirty,
                            setContextError
                          )
                        })
                        .catch((err: unknown) => {
                          setContextError(
                            err instanceof Error ? err.message : 'Failed to reset context'
                          )
                        })
                        .finally(() => setContextSaving(false))
                    }}
                  >
                    Starter template
                  </button>
                </div>
              </>
            )}
          </section>

          {contextError && (
            <p className="models-inline-msg" data-tone="danger">
              {contextError}
            </p>
          )}
        </>
      )}
    </div>
  )
}
