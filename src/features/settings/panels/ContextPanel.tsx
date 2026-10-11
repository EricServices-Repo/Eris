import { useState } from 'react'

export function useContextPanelState(hasWorkspace: boolean) {
  const [contextBody, setContextBody] = useState('')
  const [contextPin, setContextPin] = useState('')
  const [contextDirty, setContextDirty] = useState(false)
  const [contextSaving, setContextSaving] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [contextNote, setContextNote] = useState('')
  const [emailSources, setEmailSources] = useState<
    Array<{
      kind: 'thunderbird' | 'outlook' | 'eml'
      id: string
      label: string
      path?: string
      available: boolean
      detail?: string
    }>
  >([])
  const [emailSourceId, setEmailSourceId] = useState('')
  const [emailQuery, setEmailQuery] = useState('')
  const [emailMax, setEmailMax] = useState(15)
  const [emailEmlFolder, setEmailEmlFolder] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailStatus, setEmailStatus] = useState<string | null>(null)

  const loadWorkspaceContextDoc = async () => {
    if (!hasWorkspace) {
      setContextBody('')
      setContextPin('')
      setContextDirty(false)
      return
    }
    try {
      const doc = await window.ide.getWorkspaceContext()
      setContextBody(doc.body)
      setContextPin(doc.pin)
      setContextDirty(false)
      setContextError(null)
    } catch (err) {
      setContextError(err instanceof Error ? err.message : 'Failed to load context')
    }
  }

  const loadEmailSources = async (emlFolder?: string) => {
    try {
      const sources = await window.ide.emailDiscoverSources(emlFolder || emailEmlFolder || undefined)
      setEmailSources(sources)
      const available = sources.filter((s) => s.available)
      if (!emailSourceId || !sources.some((s) => s.id === emailSourceId && s.available)) {
        const preferred =
          available.find((s) => s.kind === 'thunderbird') ||
          available.find((s) => s.kind === 'outlook') ||
          available[0]
        if (preferred) setEmailSourceId(preferred.id)
      }
    } catch (err) {
      setEmailStatus(err instanceof Error ? err.message : 'Failed to discover email sources')
    }
  }

  return {
    contextBody,
    setContextBody,
    contextPin,
    setContextPin,
    contextDirty,
    setContextDirty,
    contextSaving,
    setContextSaving,
    contextError,
    setContextError,
    contextNote,
    setContextNote,
    emailSources,
    emailSourceId,
    setEmailSourceId,
    emailQuery,
    setEmailQuery,
    emailMax,
    setEmailMax,
    emailEmlFolder,
    setEmailEmlFolder,
    emailBusy,
    setEmailBusy,
    emailStatus,
    setEmailStatus,
    loadWorkspaceContextDoc,
    loadEmailSources
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
    contextPin,
    setContextPin,
    contextDirty,
    setContextDirty,
    contextSaving,
    setContextSaving,
    contextError,
    setContextError,
    contextNote,
    setContextNote,
    emailSources,
    emailSourceId,
    setEmailSourceId,
    emailQuery,
    setEmailQuery,
    emailMax,
    setEmailMax,
    emailEmlFolder,
    setEmailEmlFolder,
    emailBusy,
    setEmailBusy,
    emailStatus,
    setEmailStatus,
    loadWorkspaceContextDoc,
    loadEmailSources
  } = state
  return (
    <div className="workspace-context-panel">
      <p className="subtitle" style={{ marginTop: 0 }}>
        Durable project memory in <code>.eris/context.md</code>. Only the{' '}
        <strong>## Summary</strong> pin (~800 chars) is injected every turn; full notes stay
        on disk for <code>read_context</code> / reference.
        {!hasWorkspace && ' Open a workspace to edit.'}
      </p>
      {!hasWorkspace ? (
        <div className="subtitle">No workspace open.</div>
      ) : (
        <>
          {contextPin ? (
            <div className="workspace-context-pin">
              <div className="explorer-section-label">Pinned each turn</div>
              <pre>{contextPin}</pre>
            </div>
          ) : (
            <div className="subtitle">No summary pin yet — fill in ## Summary below.</div>
          )}
          <label className="field">
            <span>context.md</span>
            <textarea
              rows={16}
              value={contextBody}
              spellCheck={false}
              onChange={(e) => {
                setContextBody(e.target.value)
                setContextDirty(true)
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!contextDirty || contextSaving}
              onClick={() => {
                setContextSaving(true)
                void window.ide
                  .saveWorkspaceContext(contextBody)
                  .then((doc) => {
                    setContextBody(doc.body)
                    setContextPin(doc.pin)
                    setContextDirty(false)
                    setContextError(null)
                  })
                  .catch((err: unknown) => {
                    setContextError(
                      err instanceof Error ? err.message : 'Failed to save context'
                    )
                  })
                  .finally(() => setContextSaving(false))
              }}
            >
              {contextSaving ? 'Saving…' : 'Save context'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={contextSaving}
              onClick={() => void loadWorkspaceContextDoc()}
            >
              Reload
            </button>
          </div>
          <label className="field">
            <span>Quick append note</span>
            <input
              value={contextNote}
              placeholder="e.g. Auth lives in src/lib/auth.ts"
              onChange={(e) => setContextNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !contextNote.trim()) return
                e.preventDefault()
                void window.ide
                  .appendWorkspaceContextNote(contextNote)
                  .then((doc) => {
                    setContextBody(doc.body)
                    setContextPin(doc.pin)
                    setContextNote('')
                    setContextDirty(false)
                  })
                  .catch((err: unknown) => {
                    setContextError(
                      err instanceof Error ? err.message : 'Failed to append note'
                    )
                  })
              }}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!contextNote.trim() || contextSaving}
            onClick={() => {
              void window.ide
                .appendWorkspaceContextNote(contextNote)
                .then((doc) => {
                  setContextBody(doc.body)
                  setContextPin(doc.pin)
                  setContextNote('')
                  setContextDirty(false)
                })
                .catch((err: unknown) => {
                  setContextError(
                    err instanceof Error ? err.message : 'Failed to append note'
                  )
                })
            }}
          >
            Append note
          </button>

          <div className="github-section" style={{ marginTop: 20 }}>
            <h3>Email context</h3>
            <p className="model-conn-hint">
              Pull recent mail from Thunderbird (local profiles) or Outlook (AppleScript /
              .eml export). Writes <code>.eris/email-context.md</code> and a digest under{' '}
              <code>## Email</code> in context. The agent can call <code>read_email</code>.
            </p>
            <label className="field">
              <span>Source</span>
              <select
                value={emailSourceId}
                onChange={(e) => setEmailSourceId(e.target.value)}
                disabled={emailBusy}
              >
                {emailSources.map((s) => (
                  <option key={s.id} value={s.id} disabled={!s.available && s.kind !== 'eml'}>
                    {s.label}
                    {!s.available ? ' (unavailable)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {emailSources.find((s) => s.id === emailSourceId)?.detail && (
              <p className="model-conn-hint" style={{ marginTop: 0 }}>
                {emailSources.find((s) => s.id === emailSourceId)?.detail}
              </p>
            )}
            <div className="model-conn-actions">
              <button
                type="button"
                className="btn"
                disabled={emailBusy}
                onClick={() =>
                  void (async () => {
                    const picked = await window.ide.emailPickEmlFolder()
                    if (!picked.ok || !picked.path) return
                    setEmailEmlFolder(picked.path)
                    setEmailSourceId(`eml:${picked.path}`)
                    await loadEmailSources(picked.path)
                    setEmailStatus(`Using .eml folder: ${picked.path}`)
                  })()
                }
              >
                Choose .eml folder…
              </button>
              <button
                type="button"
                className="btn"
                disabled={emailBusy}
                onClick={() => void loadEmailSources()}
              >
                Refresh sources
              </button>
            </div>
            <label className="field">
              <span>Filter (optional — subject / from / body)</span>
              <input
                value={emailQuery}
                onChange={(e) => setEmailQuery(e.target.value)}
                placeholder="e.g. invoice, support@, Eris"
                disabled={emailBusy}
              />
            </label>
            <label className="field">
              <span>Max messages</span>
              <input
                type="number"
                min={1}
                max={50}
                value={emailMax}
                onChange={(e) => setEmailMax(Number(e.target.value) || 15)}
                disabled={emailBusy}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={emailBusy || !emailSourceId || !hasWorkspace}
              onClick={() =>
                void (async () => {
                  setEmailBusy(true)
                  setEmailStatus(null)
                  try {
                    let sourceId = emailSourceId
                    if (sourceId === 'eml:folder' && emailEmlFolder) {
                      sourceId = `eml:${emailEmlFolder}`
                    }
                    const result = await window.ide.emailPull({
                      sourceId,
                      query: emailQuery.trim() || undefined,
                      maxMessages: emailMax,
                      appendToContext: true
                    })
                    if (!result.ok) {
                      setEmailStatus(result.error || 'Pull failed')
                      return
                    }
                    setEmailStatus(
                      result.messages.length
                        ? `Pulled ${result.messages.length} message(s) into context`
                        : result.error || 'No messages'
                    )
                    await loadWorkspaceContextDoc()
                  } catch (err) {
                    setEmailStatus(
                      err instanceof Error ? err.message : 'Email pull failed'
                    )
                  } finally {
                    setEmailBusy(false)
                  }
                })()
              }
            >
              {emailBusy ? 'Pulling…' : 'Pull email into context'}
            </button>
            {emailStatus && (
              <p className="model-conn-hint" style={{ marginTop: 8 }}>
                {emailStatus}
              </p>
            )}
          </div>

          {contextError && (
            <div className="subtitle" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {contextError}
            </div>
          )}
        </>
      )}
    </div>
  )
}
