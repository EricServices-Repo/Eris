import { useEffect, useMemo, useState } from 'react'
import type { BugReportPreview, BugReportResult } from '@/shared/api'

export type FeedbackKind = 'bug' | 'idea' | 'question'

const KINDS: { id: FeedbackKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'Something broken or unexpected' },
  { id: 'idea', label: 'Idea', hint: 'A feature or improvement' },
  { id: 'question', label: 'Question', hint: 'How something works' }
]

interface Props {
  /** Compact layout for modal; roomier for Settings page. */
  variant?: 'page' | 'modal'
  onClose?: () => void
  onSubmitted?: () => void
  initialKind?: FeedbackKind
  initialTitle?: string
  initialDescription?: string
  initialIncludeLogs?: boolean
  initialIncludeDiagnostics?: boolean
}

export function BugReportForm({
  variant = 'page',
  onClose,
  onSubmitted,
  initialKind = 'bug',
  initialTitle = '',
  initialDescription = '',
  initialIncludeLogs = true,
  initialIncludeDiagnostics = true
}: Props) {
  const [kind, setKind] = useState<FeedbackKind>(initialKind)
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [includeLogs, setIncludeLogs] = useState(initialIncludeLogs)
  const [includeDiagnostics, setIncludeDiagnostics] = useState(initialIncludeDiagnostics)
  const [preview, setPreview] = useState<BugReportPreview | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BugReportResult | null>(null)

  const reset = () => {
    setKind('bug')
    setTitle('')
    setDescription('')
    setIncludeLogs(true)
    setIncludeDiagnostics(true)
    setPreview(null)
    setPreviewOpen(false)
    setBusy(false)
    setError(null)
    setResult(null)
  }

  useEffect(() => {
    let cancelled = false
    const t = window.setTimeout(() => {
      void window.ide
        .previewBugReport({
          title: title.trim() || 'Feedback',
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
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [title, description, includeLogs, includeDiagnostics])

  const composedTitle = useMemo(() => {
    const bare = title.trim()
    if (!bare) return ''
    if (kind === 'bug') return bare
    if (kind === 'idea') return bare.toLowerCase().startsWith('idea:') ? bare : `Idea: ${bare}`
    return bare.toLowerCase().startsWith('question:') ? bare : `Question: ${bare}`
  }, [kind, title])

  const envBits = useMemo(() => {
    const d = preview?.diagnostics
    if (!d) return [] as string[]
    return [
      `Eris ${d.appVersion}`,
      d.platform,
      d.arch,
      d.workspaceLinked ? d.workspaceName || 'workspace' : 'no workspace'
    ].filter(Boolean)
  }, [preview])

  const submit = async () => {
    if (!title.trim()) {
      setError('Add a short title.')
      return
    }
    if (!description.trim()) {
      setError(
        kind === 'idea'
          ? 'Describe the idea and why it would help.'
          : kind === 'question'
            ? 'What are you trying to figure out?'
            : 'Describe what went wrong.'
      )
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await window.ide.submitBugReport({
        title: composedTitle || title.trim(),
        description: description.trim(),
        includeLogs,
        includeDiagnostics
      })
      setResult(res)
      if (!res.ok && res.error) setError(res.error)
      else if (res.ok) onSubmitted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (result?.ok) {
    return (
      <div className={`feedback-success feedback-success--${variant}`}>
        <div className="feedback-success-mark" aria-hidden>
          ✓
        </div>
        <h3>Thanks — we got it</h3>
        <p>
          {typeof result.number === 'number'
            ? `Your report was filed as #${result.number}.`
            : 'Your report was filed.'}{' '}
          No GitHub account needed on your side.
        </p>
        <div className="feedback-success-actions">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Send another
          </button>
          {onClose && (
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    )
  }

  const descPlaceholder =
    kind === 'idea'
      ? 'What should Eris do differently? Who would it help?'
      : kind === 'question'
        ? 'What are you trying to do, and where are you stuck?'
        : 'What you were doing, what you expected, and what went wrong…'

  return (
    <div className={`feedback-form feedback-form--${variant}`}>
      <div className="feedback-kind" role="tablist" aria-label="Feedback type">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            className={`feedback-kind-btn${kind === k.id ? ' is-active' : ''}`}
            onClick={() => setKind(k.id)}
            title={k.hint}
          >
            <strong>{k.label}</strong>
            <span>{k.hint}</span>
          </button>
        ))}
      </div>

      <label className="feedback-field">
        <span className="feedback-label">Title</span>
        <input
          autoFocus={variant === 'modal'}
          value={title}
          maxLength={200}
          placeholder={
            kind === 'bug'
              ? 'e.g. Diff Review freezes on large files'
              : kind === 'idea'
                ? 'e.g. Keyboard shortcut for Apply All'
                : 'e.g. How do Cloud Agents use my workspace?'
          }
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onClose) onClose()
          }}
        />
      </label>

      <label className="feedback-field">
        <span className="feedback-label">Details</span>
        <textarea
          value={description}
          rows={variant === 'page' ? 8 : 6}
          placeholder={descPlaceholder}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="feedback-attach">
        <span className="feedback-label">Include with report</span>
        <label className={`feedback-attach-card${includeDiagnostics ? ' is-on' : ''}`}>
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(e) => setIncludeDiagnostics(e.target.checked)}
          />
          <div>
            <strong>Environment</strong>
            <span>App version, OS, model, and account status (no secrets).</span>
          </div>
        </label>
        <label className={`feedback-attach-card${includeLogs ? ' is-on' : ''}`}>
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(e) => setIncludeLogs(e.target.checked)}
          />
          <div>
            <strong>Recent app logs</strong>
            <span>
              Helps reproduce crashes
              {preview?.logTruncated ? ' · log tail truncated' : ''}. Tokens are redacted.
            </span>
          </div>
        </label>
      </div>

      {envBits.length > 0 && (
        <div className="feedback-chips" aria-label="Environment snapshot">
          {envBits.map((bit) => (
            <span key={bit} className="feedback-chip">
              {bit}
            </span>
          ))}
        </div>
      )}

      <button
        type="button"
        className="feedback-preview-toggle"
        onClick={() => setPreviewOpen((v) => !v)}
      >
        {previewOpen ? 'Hide what will be sent' : 'Preview what will be sent'}
      </button>
      {previewOpen && preview && <pre className="bug-report-preview">{preview.body}</pre>}

      {error && (
        <div className="conn-strip-item tone-danger" style={{ padding: '8px 10px' }}>
          {error}
        </div>
      )}

      <div className="feedback-footer">
        <p className="feedback-privacy">
          Sent from Eris in the background. No GitHub login or token setup.
        </p>
        <div className="feedback-footer-actions">
          {onClose && (
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : kind === 'bug' ? 'Submit report' : 'Send feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
