import { ownsReviewShortcut } from '@/components/focus-ownership'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MonacoDiffEditor } from 'react-monaco-editor'
import type { editor as MonacoEditorNS } from 'monaco-editor'
import { diffLineStats, languageFromPath, type DiffLineStat } from '@/shared/diff-stats'

export interface PendingDiff {
  id: string
  checkpointId: string
  opIndex: number
  path: string
  before: string | null
  after: string
  op: 'write' | 'delete' | 'rename' | 'mkdir' | 'binary'
  conflict?: string
  status: 'pending' | 'kept' | 'undone'
}

interface Props {
  diffs: PendingDiff[]
  onKeep: (id: string) => void
  onUndoFile: (id: string) => void
  onUndoAll: () => void
  onKeepAll: () => void
  onOpenPath: (path: string) => void
  onDismiss?: () => void
  /** User-level preference: auto-keep agent changes */
  autoKeepDiffs?: boolean
  onAutoKeepDiffsChange?: (enabled: boolean) => void
  /** Monaco theme from Settings → Editor */
  theme?: string
  /** Notify parent when expand toggles (taller drawer). */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Git: stage kept files, commit, push, open PR */
  onStageKept?: () => void
  onCommitKept?: () => void
  /** Stage → commit (default message) → push — primary finish flow */
  onCommitAndPush?: () => void
  onCreatePr?: () => void
  gitBusy?: boolean
}

function statusLabel(status: PendingDiff['status']): string {
  if (status === 'pending') return 'pending'
  if (status === 'kept') return 'kept'
  return 'undone'
}

function openablePath(path: string): string {
  return path.split(' → ')[0] || path
}

function fileName(path: string): string {
  const p = openablePath(path)
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

function dirName(path: string): string {
  const p = openablePath(path)
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(0, idx) : ''
}

export function DiffReview({
  diffs,
  onKeep,
  onUndoFile,
  onUndoAll,
  onKeepAll,
  onOpenPath,
  onDismiss,
  autoKeepDiffs = false,
  onAutoKeepDiffsChange,
  theme = 'vs-dark',
  expanded: expandedProp,
  onExpandedChange,
  onStageKept,
  onCommitKept,
  onCommitAndPush,
  onCreatePr,
  gitBusy = false
}: Props) {
  const reviewRef = useRef<HTMLDivElement>(null)
  const hasDiffs = diffs.length > 0
  const pending = diffs.filter((d) => d.status === 'pending')
  const kept = diffs.filter((d) => d.status === 'kept')
  const [openId, setOpenId] = useState<string | null>(pending[0]?.id ?? diffs[0]?.id ?? null)
  const [renderSideBySide, setRenderSideBySide] = useState(true)
  const [expandedLocal, setExpandedLocal] = useState(true)
  const expanded = expandedProp ?? expandedLocal
  const setExpanded = (value: boolean) => {
    onExpandedChange?.(value)
    if (expandedProp === undefined) setExpandedLocal(value)
  }

  const active = useMemo(
    () => diffs.find((d) => d.id === openId) ?? pending[0] ?? diffs[0] ?? null,
    [diffs, openId, pending]
  )

  const statsById = useMemo(() => {
    const map = new Map<string, DiffLineStat>()
    for (const d of diffs) {
      if (d.op === 'write') {
        map.set(d.id, diffLineStats(d.before ?? '', d.after))
      } else if (d.op === 'delete') {
        map.set(d.id, {
          added: 0,
          removed: (d.before ?? '').split('\n').filter(Boolean).length || 1
        })
      } else if (d.op === 'mkdir') {
        map.set(d.id, { added: 1, removed: 0 })
      } else {
        map.set(d.id, { added: 1, removed: 1 })
      }
    }
    return map
  }, [diffs])

  const totalStats = useMemo(() => {
    let added = 0
    let removed = 0
    for (const s of statsById.values()) {
      added += s.added
      removed += s.removed
    }
    return { added, removed }
  }, [statsById])

  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath
  const activeId = active?.id
  const activePath = active?.path
  useEffect(() => {
    if (activeId && activePath) onOpenPathRef.current(openablePath(activePath))
  }, [activeId, activePath])

  // Keep selection on a live file when the list shrinks / status changes
  useEffect(() => {
    if (!openId) return
    if (!diffs.some((d) => d.id === openId)) {
      setOpenId(pending[0]?.id ?? diffs[0]?.id ?? null)
    }
  }, [diffs, openId, pending])

  const diffEditorRef = useRef<MonacoEditorNS.IStandaloneDiffEditor | null>(null)

  const selectFile = (id: string) => {
    const d = diffs.find((x) => x.id === id)
    setOpenId(id)
    if (d && d.op !== 'binary') onOpenPath(openablePath(d.path))
  }

  const goHunk = (target: 'next' | 'previous') => {
    diffEditorRef.current?.goToDiff(target)
  }

  const diffsRef = useRef(diffs)
  diffsRef.current = diffs
  const activeIdRef = useRef(active?.id ?? openId)
  activeIdRef.current = active?.id ?? openId

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!reviewRef.current || !ownsReviewShortcut(e, reviewRef.current)) return
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        diffEditorRef.current?.goToDiff('next')
      } else if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        diffEditorRef.current?.goToDiff('previous')
      } else if ((e.key === 'j' || e.key === 'k') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const list = diffsRef.current
        if (!list.length) return
        const idx = Math.max(
          0,
          list.findIndex((d) => d.id === activeIdRef.current)
        )
        const dir = e.key === 'j' ? 1 : -1
        const next = list[(idx + dir + list.length) % list.length]
        if (next) {
          setOpenId(next.id)
          onOpenPathRef.current(openablePath(next.path))
        }
      }
    }
    const review = reviewRef.current
    review?.addEventListener('keydown', onKey)
    return () => review?.removeEventListener('keydown', onKey)
  }, [hasDiffs])

  if (diffs.length === 0) return null

  const lang = active ? languageFromPath(active.path) : 'plaintext'
  const showDiffEditor = active?.op === 'write'

  return (
    <div
      ref={reviewRef}
      tabIndex={0}
      role="region"
      aria-label="Review changes"
      data-keyboard-owner="review"
      aria-keyshortcuts="n p j k"
      className={`diff-review ${expanded ? 'is-expanded' : 'is-compact'}`}
    >
      <div className="diff-review-head">
        <strong>Review changes</strong>
        <span className="subtitle">Focus review: N/P hunks · J/K files · Tab actions</span>
        <span className="diff-count" role="status" aria-live="polite" aria-atomic="true">
          <span className="diff-count-pending">{pending.length} pending</span>
          {' · '}
          <span className="diff-count-kept">{kept.length} kept</span>
          {' · '}
          <span className="diff-stat-add">+{totalStats.added}</span>{' '}
          <span className="diff-stat-del">−{totalStats.removed}</span>
        </span>
        <div className="diff-actions">
          <button
            type="button"
            className="btn"
            title={expanded ? 'Compact review' : 'Expand review'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Compact' : 'Expand'}
          </button>
          <button
            type="button"
            className="btn"
            title="Side-by-side or inline"
            onClick={() => setRenderSideBySide((v) => !v)}
          >
            {renderSideBySide ? 'Inline' : 'Split'}
          </button>
          <button type="button" className="btn" disabled={!pending.length} onClick={onKeepAll}>
            Keep all
          </button>
          <button type="button" className="btn" disabled={!pending.length} onClick={onUndoAll}>
            Undo pending
          </button>
          {onCommitAndPush && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={gitBusy || kept.length === 0}
              title="Stage kept files, commit with a default message, and push"
              onClick={onCommitAndPush}
            >
              {gitBusy ? 'Working…' : 'Commit & Push'}
            </button>
          )}
          {onStageKept && (
            <button
              type="button"
              className="btn"
              disabled={gitBusy || kept.length === 0}
              title="git add kept files"
              onClick={onStageKept}
            >
              Stage kept
            </button>
          )}
          {onCommitKept && (
            <button
              type="button"
              className="btn"
              disabled={gitBusy || kept.length === 0}
              title="Stage kept files and commit (local only)"
              onClick={onCommitKept}
            >
              Commit…
            </button>
          )}
          {onCreatePr && (
            <button
              type="button"
              className="btn"
              disabled={gitBusy || kept.length === 0}
              title="Commit kept files and open a GitHub pull request"
              onClick={onCreatePr}
            >
              Open PR…
            </button>
          )}
          {onAutoKeepDiffsChange && (
            <label
              className="diff-always-keep"
              title="Save as a user setting — keep all future agent edits without review"
            >
              <input
                type="checkbox"
                checked={autoKeepDiffs}
                onChange={(e) => {
                  const enabled = e.target.checked
                  onAutoKeepDiffsChange(enabled)
                  if (enabled) onKeepAll()
                }}
              />
              Always keep
            </label>
          )}
          {onDismiss && pending.length === 0 && (
            <button type="button" className="btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>

      <div className="diff-review-body">
        <aside className="diff-file-tree" aria-label="Changed files">
          {diffs.map((d) => {
            const stats = statsById.get(d.id) || { added: 0, removed: 0 }
            const dir = dirName(d.path)
            return (
              <button
                key={d.id}
                type="button"
                className={`diff-file-row ${d.id === active?.id ? 'active' : ''} status-${d.status}`}
                onClick={() => selectFile(d.id)}
                title={d.path}
              >
                <span className={`diff-op-pill op-${d.op}`}>{d.op}</span>
                <span className="diff-file-meta">
                  <span className="diff-file-name">{fileName(d.path)}</span>
                  {dir ? <span className="diff-file-dir">{dir}</span> : null}
                </span>
                <span className="diff-file-stats">
                  {stats.added > 0 && <span className="diff-stat-add">+{stats.added}</span>}
                  {stats.removed > 0 && <span className="diff-stat-del">−{stats.removed}</span>}
                </span>
                <span className={`diff-status badge status-${d.status}`}>
                  {statusLabel(d.status)}
                </span>
              </button>
            )
          })}
        </aside>

        {active && (
          <div className="diff-pane">
            <div className="diff-pane-bar">
              <button
                type="button"
                className="md-path"
                disabled={active.op === 'binary'}
                onClick={() => onOpenPath(openablePath(active.path))}
              >
                {active.path}
              </button>
              <span className={`diff-status badge status-${active.status}`}>
                {statusLabel(active.status)}
              </span>
              {showDiffEditor && (
                <div className="diff-hunk-nav">
                  <button
                    type="button"
                    className="btn"
                    title="Previous hunk (p)"
                    onClick={() => goHunk('previous')}
                  >
                    ↑ Hunk
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="Next hunk (n)"
                    onClick={() => goHunk('next')}
                  >
                    ↓ Hunk
                  </button>
                </div>
              )}
              {active.status === 'pending' && (
                <div className="diff-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => onKeep(active.id)}
                  >
                    Keep
                  </button>
                  <button type="button" className="btn" onClick={() => onUndoFile(active.id)}>
                    Undo file
                  </button>
                </div>
              )}
            </div>

            {active.conflict && (
              <p className="error" role="alert">
                {active.conflict}
              </p>
            )}
            {showDiffEditor ? (
              <div className="diff-monaco-host">
                <MonacoDiffEditor
                  key={`${active.id}:${renderSideBySide ? 'split' : 'inline'}`}
                  width="100%"
                  height="100%"
                  language={lang}
                  theme={theme}
                  original={active.before ?? ''}
                  value={active.after}
                  options={{
                    readOnly: true,
                    renderSideBySide,
                    originalEditable: false,
                    renderIndicators: true,
                    renderMarginRevertIcon: false,
                    ignoreTrimWhitespace: false,
                    enableSplitViewResizing: true,
                    scrollBeyondLastLine: false,
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineNumbers: 'on',
                    glyphMargin: false,
                    folding: true,
                    automaticLayout: true,
                    scrollbar: {
                      verticalScrollbarSize: 10,
                      horizontalScrollbarSize: 10
                    }
                  }}
                  editorDidMount={(editor) => {
                    diffEditorRef.current = editor
                    void editor.revealFirstDiff()
                  }}
                />
              </div>
            ) : (
              <div className="diff-op-summary">
                <p>
                  <strong>{active.op}</strong> · <code>{active.path}</code>
                </p>
                {active.op === 'delete' && (
                  <pre className="diff-lines">
                    {(active.before ?? '(empty)')
                      .split('\n')
                      .slice(0, 80)
                      .map((line, i) => (
                        <div key={i} className="diff-line diff-del">
                          <span className="diff-mark">−</span>
                          {line}
                        </div>
                      ))}
                  </pre>
                )}
                {active.op === 'rename' && (
                  <p className="hint">
                    File was renamed. Keep to accept; Undo restores the previous path.
                  </p>
                )}
                {active.op === 'binary' && (
                  <p>{active.after}. Keep or undo this generated image.</p>
                )}
                {active.op === 'mkdir' && (
                  <p className="hint">Directory was created. Undo removes it if still empty.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
