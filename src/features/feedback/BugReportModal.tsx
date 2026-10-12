import { useEffect, useState } from 'react'
import type { BugReportPreview, BugReportResult } from '@/shared/api'

interface Props {
  open: boolean
  onClose: () => void
}

export function BugReportModal({ open, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [includeLogs, setIncludeLogs] = useState(true)
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [preview, setPreview] = useState<BugReportPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BugReportResult | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setIncludeLogs(true)
    setIncludeDiagnostics(true)
    setPreview(null)
    setPreviewOpen(false)
    setBusy(false)
    setError(null)
    setResult(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.ide
      .previewBugReport({
        title: title.trim() || 'Bug report',
        description: description.trim() || '(draft)',
        includeLogs,
        includeDiagnostics
      })
      .then((p) => {
        if (!cancelled) setPreview(p)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, title, description, includeLogs, includeDiagnostics])

  if (!open) return null

  const submit = async () => {
    if (!title.trim()) {
      setError('Add a short title.')
      return
    }
    if (!description.trim()) {
      setError('Describe what went wrong.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await window.ide.submitBugReport({
        title: title.trim(),
        description: description.trim(),
        includeLogs,
        includeDiagnostics,
        openBrowserFallback: true
      })
      setResult(res)
      if (res.ok && res.htmlUrl) {
        setError(null)
      } else if (!res.ok && res.error) {
        // Browser/clipboard fallback still helps the user file the issue
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal bug-report-modal"
        style={{
          width: 'min(560px, 94vw)',
          height: 'auto',
          maxHeight: 'min(88vh, 720px)',
          gridTemplateColumns: '1fr',
          padding: 0,
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '18px 20px 8px' }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Report a Bug</h2>
          <p className="model-conn-hint" style={{ margin: 0 }}>
            Files an issue on{' '}
            <code>EricServices-Repo/Eris-feedback</code> with diagnostics and recent logs (secrets
            redacted). Uses your GitHub token from Settings → GitHub.
          </p>
        </div>

        <div
          style={{
            padding: '8px 20px 16px',
            overflow: 'auto',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }}
        >
          <label className="field">
            <span>Title</span>
            <input
              autoFocus
              value={title}
              maxLength={200}
              placeholder="Short summary (e.g. Diff Review crashes on large files)"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose()
              }}
            />
          </label>

          <label className="field">
            <span>What happened</span>
            <textarea
              value={description}
              rows={6}
              placeholder="What you were doing, what you expected, and what went wrong…"
              onChange={(e) => setDescription(e.target.value)}
              style={{ resize: 'vertical', minHeight: 120 }}
            />
          </label>

          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(e) => setIncludeDiagnostics(e.target.checked)}
            />
            <span>Include environment diagnostics</span>
          </label>

          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={includeLogs}
              onChange={(e) => setIncludeLogs(e.target.checked)}
            />
            <span>
              Include recent app logs
              {preview?.logTruncated ? ' (tail truncated)' : ''}
            </span>
          </label>

          {preview && (
            <div className="bug-report-meta hint">
              Target: <code>{preview.targetRepo}</code>
              {' · '}
              {preview.hasGithubToken ? 'GitHub token ready' : 'No token — will open browser draft'}
              {preview.logIncluded && preview.logPath
                ? ` · log ${preview.logPath.split(/[/\\]/).pop()}`
                : ''}
            </div>
          )}

          <button
            type="button"
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {previewOpen ? 'Hide preview' : 'Preview issue body'}
          </button>

          {previewOpen && preview && (
            <pre className="bug-report-preview">{preview.body}</pre>
          )}

          {error && (
            <div className="conn-strip-item tone-danger" style={{ padding: '8px 10px' }}>
              {error}
            </div>
          )}

          {result?.ok && result.htmlUrl && (
            <div className="conn-strip-item tone-info" style={{ padding: '8px 10px' }}>
              Issue created
              {typeof result.number === 'number' ? ` #${result.number}` : ''} and opened in your
              browser.
              <div className="hint" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                {result.htmlUrl}
              </div>
            </div>
          )}

          {!result?.ok && (result?.openedBrowser || result?.copiedToClipboard) && (
            <div className="conn-strip-item tone-warn" style={{ padding: '8px 10px' }}>
              {result.openedBrowser
                ? 'Opened a GitHub issue draft in your browser. '
                : ''}
              {result.copiedToClipboard
                ? 'Full report (with logs) is on your clipboard — paste into the issue body if needed.'
                : ''}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8
          }}
        >
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {!result?.ok && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? 'Submitting…' : 'Submit to GitHub'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
