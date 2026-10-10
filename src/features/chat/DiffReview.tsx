import { useEffect, useMemo, useState } from 'react'

export interface PendingDiff {
  id: string
  checkpointId: string
  opIndex: number
  path: string
  before: string | null
  after: string
  op: 'write' | 'delete' | 'rename' | 'mkdir'
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
}

function lineDiff(before: string, after: string): Array<{ type: 'same' | 'add' | 'del'; text: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! })
      i++
      j++
    } else if (j < b.length && (i >= a.length || !a.slice(i).includes(b[j]!))) {
      out.push({ type: 'add', text: b[j]! })
      j++
    } else if (i < a.length) {
      out.push({ type: 'del', text: a[i]! })
      i++
    } else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
    if (out.length > 400) {
      out.push({ type: 'same', text: '…' })
      break
    }
  }
  return out
}

function statusLabel(status: PendingDiff['status']): string {
  if (status === 'pending') return 'pending'
  if (status === 'kept') return 'kept'
  return 'undone'
}

function openablePath(path: string): string {
  return path.split(' → ')[0] || path
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
  onAutoKeepDiffsChange
}: Props) {
  const pending = diffs.filter((d) => d.status === 'pending')
  const kept = diffs.filter((d) => d.status === 'kept')
  const [openId, setOpenId] = useState<string | null>(pending[0]?.id ?? diffs[0]?.id ?? null)
  const active = useMemo(
    () => diffs.find((d) => d.id === openId) ?? pending[0] ?? diffs[0] ?? null,
    [diffs, openId, pending]
  )

  useEffect(() => {
    if (!active) return
    onOpenPath(openablePath(active.path))
  }, [active?.id])

  if (diffs.length === 0) return null

  const rows =
    active && active.op === 'write'
      ? lineDiff(active.before ?? '', active.after)
      : active
        ? [{ type: 'same' as const, text: `${active.op}: ${active.path}` }]
        : []

  return (
    <div className="diff-review">
      <div className="diff-review-head">
        <strong>Review changes</strong>
        <span className="diff-count">
          <span className="diff-count-pending">{pending.length} pending</span>
          {' · '}
          <span className="diff-count-kept">{kept.length} kept</span>
          {' · '}
          {diffs.length} total
        </span>
        <div className="diff-actions">
          <button type="button" className="btn" disabled={!pending.length} onClick={onKeepAll}>
            Keep all
          </button>
          <button type="button" className="btn" disabled={!pending.length} onClick={onUndoAll}>
            Undo all
          </button>
          {onAutoKeepDiffsChange && (
            <label className="diff-always-keep" title="Save as a user setting — keep all future agent edits without review">
              <input
                type="checkbox"
                checked={autoKeepDiffs}
                onChange={(e) => {
                  const enabled = e.target.checked
                  onAutoKeepDiffsChange(enabled)
                  if (enabled) onKeepAll()
                }}
              />
              Always keep all
            </label>
          )}
          {onDismiss && pending.length === 0 && (
            <button type="button" className="btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
      <div className="diff-file-list">
        {diffs.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`diff-file ${d.id === active?.id ? 'active' : ''} status-${d.status}`}
            onClick={() => {
              setOpenId(d.id)
              onOpenPath(openablePath(d.path))
            }}
          >
            <span className="diff-op">{d.op}</span>
            <span className="diff-path">{d.path}</span>
            <span className={`diff-status badge status-${d.status}`}>{statusLabel(d.status)}</span>
          </button>
        ))}
      </div>
      {active && (
        <div className="diff-pane">
          <div className="diff-pane-bar">
            <button
              type="button"
              className="md-path"
              onClick={() => onOpenPath(openablePath(active.path))}
            >
              {active.path}
            </button>
            <span className={`diff-status badge status-${active.status}`}>
              {statusLabel(active.status)}
            </span>
            {active.status === 'pending' && (
              <div className="diff-actions">
                <button type="button" className="btn btn-primary" onClick={() => onKeep(active.id)}>
                  Keep
                </button>
                <button type="button" className="btn" onClick={() => onUndoFile(active.id)}>
                  Undo file
                </button>
              </div>
            )}
          </div>
          <pre className="diff-lines">
            {rows.map((r, i) => (
              <div key={i} className={`diff-line diff-${r.type}`}>
                <span className="diff-mark">
                  {r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}
                </span>
                {r.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
