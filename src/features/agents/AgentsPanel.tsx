import { useCallback, useEffect, useState } from 'react'
import type { BackgroundJob } from '@/shared/background-agents'

interface Props {
  open: boolean
  workspacePath: string | null
  defaultModel: string
  onClose: () => void
  onOpenPath?: (path: string) => void
}

export function AgentsPanel({ open, workspacePath, defaultModel, onClose }: Props) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([])
  const [goal, setGoal] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const list = await window.ide.listBackgroundJobs()
    setJobs(list)
    setSelectedId((id) => id ?? list[0]?.id ?? null)
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    return window.ide.onBackgroundJob((evt) => {
      if (evt.type === 'upsert') {
        setJobs((prev) => {
          const next = prev.filter((j) => j.id !== evt.job.id)
          next.unshift(evt.job)
          return next
        })
      } else {
        setJobs((prev) => prev.filter((j) => j.id !== evt.id))
      }
    })
  }, [open, refresh])

  useEffect(() => {
    if (!selectedId) {
      setDiff('')
      return
    }
    void window.ide.backgroundJobDiff(selectedId).then((r) => {
      setDiff(r.diff || r.error || '')
    })
  }, [selectedId, jobs])

  if (!open) return null
  const selected = jobs.find((j) => j.id === selectedId) ?? null
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length

  return (
    <div className="git-panel">
      <div className="terminal-bar">
        <strong>Agents</strong>
        <span className="thinking-status-inline">
          {running > 0 ? `${running} running` : 'idle'}
        </span>
        <div className="diff-actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Editor
          </button>
        </div>
      </div>
      {error && <div className="git-error">{error}</div>}
      <div className="git-commit-row">
        <input
          value={goal}
          placeholder="Goal for a background agent (own git worktree)"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && goal.trim() && workspacePath) {
              e.preventDefault()
              setBusy(true)
              setError(null)
              void window.ide
                .enqueueBackgroundJob({ goal: goal.trim(), model: defaultModel })
                .then((job) => {
                  setGoal('')
                  setSelectedId(job.id)
                })
                .catch((err) => setError(err instanceof Error ? err.message : 'Failed to start'))
                .finally(() => setBusy(false))
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !goal.trim() || !workspacePath}
          onClick={() => {
            setBusy(true)
            setError(null)
            void window.ide
              .enqueueBackgroundJob({ goal: goal.trim(), model: defaultModel })
              .then((job) => {
                setGoal('')
                setSelectedId(job.id)
              })
              .catch((err) => setError(err instanceof Error ? err.message : 'Failed to start'))
              .finally(() => setBusy(false))
          }}
        >
          Start
        </button>
      </div>
      <div className="git-body">
        <div className="git-files">
          <div className="explorer-section-label">Inbox</div>
          {jobs.length === 0 ? (
            <div className="chat-empty">No background agents yet.</div>
          ) : (
            jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                className={`git-file${j.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(j.id)}
              >
                <span className="diff-op">{j.status}</span>
                <span>{j.goal.slice(0, 80)}</span>
              </button>
            ))
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          {selected && (
            <div className="debug-toolbar">
              <button
                type="button"
                className="btn"
                disabled={selected.status !== 'running' && selected.status !== 'queued'}
                onClick={() => void window.ide.stopBackgroundJob(selected.id)}
              >
                Stop
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selected.status !== 'done'}
                onClick={() =>
                  void window.ide
                    .mergeBackgroundJob(selected.id)
                    .then(() => refresh())
                    .catch((err) => setError(err instanceof Error ? err.message : 'Merge failed'))
                }
              >
                Merge
              </button>
              <button
                type="button"
                className="btn"
                disabled={selected.status === 'merged'}
                onClick={() =>
                  void window.ide
                    .discardBackgroundJob(selected.id)
                    .then(() => refresh())
                    .catch((err) => setError(err instanceof Error ? err.message : 'Discard failed'))
                }
              >
                Discard
              </button>
            </div>
          )}
          <pre className="git-diff">
            {selected
              ? `${selected.status} · ${selected.branch || 'no branch'}\n${selected.error ? selected.error + '\n' : ''}${selected.actionLog.slice(-12).join('\n')}\n\n${selected.answer || ''}\n\n${diff}`
              : 'Start a job to run an agent on a private branch. Review the diff, then merge or discard.'}
          </pre>
        </div>
      </div>
      <div className="debug-hint">
        Each job is a git worktree. Your open files stay untouched until you merge.
      </div>
    </div>
  )
}
